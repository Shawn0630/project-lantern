// Worker heartbeat upsert: a redeploy (new container hostname, same
// stable worker id) must update the existing row in place instead of
// registering a duplicate, and a restart under the same id must
// re-offer the dead incarnation's in-flight tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../src/routes.js';

function fakeStore(workers) {
  return {
    workers,
    listJobs() { return []; },
    listWorkers() { return this.workers; },
    saveWorkers(w) { this.workers = w; },
  };
}

async function startServer(store, runner = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, runner));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return server;
}

async function withServer(store, runner, fn) {
  const server = await startServer(store, runner);
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function heartbeat(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/workers/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function getWorkers(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/workers`);
  assert.equal(res.status, 200);
  return res.json();
}

function hb(id, host, extra = {}) {
  return { id, host, port: 9500, name: host, bootId: 'boot-1', ...extra };
}

test('heartbeat creates one row keyed by the stable id', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    const workers = await getWorkers(port);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].workerId, 'stable-1');
    assert.equal(workers[0].host, 'aaa111aaaaaa');
    assert.equal(workers[0].status, 'online');
    assert.equal(workers[0].registered, false);
  });
});

test('heartbeat with the same stable id from a new host updates the row, no duplicate', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    await heartbeat(port, hb('stable-1', 'bbb222bbbbbb'));
    const workers = await getWorkers(port);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].workerId, 'stable-1');
    assert.equal(workers[0].host, 'bbb222bbbbbb');
    assert.equal(workers[0].name, 'bbb222bbbbbb');
    assert.equal(workers[0].status, 'online');
  });
});

test('heartbeat with a new stable id creates a second row', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    await heartbeat(port, hb('stable-2', 'ccc333cccccc'));
    const workers = await getWorkers(port);
    assert.equal(workers.length, 2);
    assert.deepEqual(workers.map((w) => w.workerId).sort(), ['stable-1', 'stable-2']);
  });
});

test('heartbeat merges into a pre-registered row by host:port', async () => {
  const store = fakeStore([{
    id: 'worker_reg', workerId: null, name: '192.168.1.10:9500',
    host: '192.168.1.10', port: 9500, status: 'offline', registered: true,
    lastSeen: null, load: null, model: null, version: null,
    createdAt: '2026-11-14T00:00:00.000Z',
  }]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-9', '192.168.1.10'));
    const workers = await getWorkers(port);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].id, 'worker_reg');
    assert.equal(workers[0].registered, true);
    assert.equal(workers[0].workerId, 'stable-9');
    assert.equal(workers[0].status, 'online');
  });
});

test('boot change under the same stable id re-queues in-flight tasks', async () => {
  const store = fakeStore([{
    id: 'worker_x', workerId: 'stable-1', bootId: 'boot-1',
    name: 'aaa111aaaaaa', host: 'aaa111aaaaaa', port: 9500,
    status: 'online', registered: false,
    lastSeen: '2026-11-14T00:00:00.000Z',
  }]);
  const calls = [];
  const runner = { requeueWorkerTasks(id, reason) { calls.push([id, reason]); return 1; } };
  await withServer(store, runner, async (port) => {
    await heartbeat(port, hb('stable-1', 'bbb222bbbbbb', { bootId: 'boot-2' }));
    assert.deepEqual(calls, [['stable-1', 'worker restarted']]);
    const workers = await getWorkers(port);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].bootId, 'boot-2');
    assert.equal(workers[0].host, 'bbb222bbbbbb');
  });
});

test('same bootId does not re-queue', async () => {
  const store = fakeStore([{
    id: 'worker_x', workerId: 'stable-1', bootId: 'boot-1',
    name: 'aaa111aaaaaa', host: 'aaa111aaaaaa', port: 9500,
    status: 'online', registered: false,
    lastSeen: '2026-11-14T00:00:00.000Z',
  }]);
  const calls = [];
  const runner = { requeueWorkerTasks(id, reason) { calls.push([id, reason]); return 1; } };
  await withServer(store, runner, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa', { bootId: 'boot-1' }));
    assert.deepEqual(calls, []);
  });
});
