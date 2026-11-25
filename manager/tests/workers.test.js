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

// ---- models report + per-worker settings ----
async function postJson(port, path, body, expectStatus = 200) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, expectStatus);
  return res.json();
}

async function postSettings(port, id, body, expectStatus = 200) {
  return postJson(port, `/api/workers/${encodeURIComponent(id)}/settings`, body, expectStatus);
}

async function firstWorkerId(port) {
  const workers = await getWorkers(port);
  assert.equal(workers.length, 1);
  return workers[0].id;
}

test('heartbeat stores the worker models report', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa', {
      models: { loaded: 'large-v3-turbo', available: ['large-v3', 'large-v3-turbo'] },
    }));
    const workers = await getWorkers(port);
    assert.deepEqual(workers[0].models, { loaded: 'large-v3-turbo', available: ['large-v3', 'large-v3-turbo'] });
    // A heartbeat without a models report leaves the last report in place.
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    assert.deepEqual((await getWorkers(port))[0].models,
      { loaded: 'large-v3-turbo', available: ['large-v3', 'large-v3-turbo'] });
  });
});

test('heartbeat stores the worker engines report', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa', {
      engines: ['faster-whisper', 'whisperjav'],
    }));
    const workers = await getWorkers(port);
    assert.deepEqual(workers[0].engines, ['faster-whisper', 'whisperjav']);
    // An unknown engine name is filtered out; a heartbeat without an
    // engines report leaves the last report in place.
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa', { engines: ['faster-whisper', 'nope'] }));
    assert.deepEqual((await getWorkers(port))[0].engines, ['faster-whisper']);
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    assert.deepEqual((await getWorkers(port))[0].engines, ['faster-whisper']);
  });
});

test('POST /workers/:id/settings pins an engine and validates it', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    const id = await firstWorkerId(port);
    const pinned = await postSettings(port, id, { enginePin: 'whisperjav' });
    assert.equal(pinned.enginePin, 'whisperjav');
    await postSettings(port, id, { enginePin: 'not-an-engine' }, 400);
    const cleared = await postSettings(port, id, { enginePin: null });
    assert.equal(cleared.enginePin, null);
    // The model pin and engine pin are independent.
    const both = await postSettings(port, id, { modelPin: 'large-v3', enginePin: 'whisperjav' });
    assert.equal(both.modelPin, 'large-v3');
    assert.equal(both.enginePin, 'whisperjav');
  });
});

test('POST /workers/:id/settings pins a model and validates it', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    const id = await firstWorkerId(port);
    const pinned = await postSettings(port, id, { modelPin: 'large-v3-turbo' });
    assert.equal(pinned.modelPin, 'large-v3-turbo');
    await postSettings(port, id, { modelPin: 'not-a-model' }, 400);
    const cleared = await postSettings(port, id, { modelPin: null });
    assert.equal(cleared.modelPin, null);
    await postSettings(port, 'no-such-worker', { modelPin: 'large-v3' }, 404);
  });
});

test('POST /workers/:id/settings stores an LLM override and never returns the key', async () => {
  const store = fakeStore([]);
  await withServer(store, {}, async (port) => {
    await heartbeat(port, hb('stable-1', 'aaa111aaaaaa'));
    const id = await firstWorkerId(port);
    const saved = await postSettings(port, id, { llm: { apiKey: 'sk-secret-1234', model: 'gemini-2.5-pro' } });
    assert.deepEqual(saved.llm, { configured: true, model: 'gemini-2.5-pro', keyHint: '••••1234' });
    // The raw key lives only in the server-side record, never in API output.
    const raw = JSON.stringify(await getWorkers(port));
    assert.equal(raw.includes('sk-secret-1234'), false);
    assert.equal(raw.includes('••••1234'), true);
    assert.equal(store.workers[0].llm.apiKey, 'sk-secret-1234');
    // A partial update keeps the stored key when apiKey is omitted.
    const kept = await postSettings(port, id, { llm: { model: 'gemini-2.0-flash' } });
    assert.deepEqual(kept.llm, { configured: true, model: 'gemini-2.0-flash', keyHint: '••••1234' });
    // Clearing the key keeps the model override.
    const noKey = await postSettings(port, id, { llm: { apiKey: '' } });
    assert.deepEqual(noKey.llm, { configured: false, model: 'gemini-2.0-flash', keyHint: null });
    // Clearing the whole override returns llm to null.
    const cleared = await postSettings(port, id, { llm: null });
    assert.equal(cleared.llm, null);
  });
});
