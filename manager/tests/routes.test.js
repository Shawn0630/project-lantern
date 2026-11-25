// GET /api/workers enriches each worker with the task it is currently
// running (or null when idle), so the Workers page can show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from '../src/routes.js';

function fakeStore(jobs, workers) {
  return {
    listJobs() { return jobs; },
    listWorkers() { return workers; },
  };
}

function task(id, type, state, extra = {}) {
  return {
    id, type, state,
    attempts: 0, weight: 0, queuedAt: '2026-11-14T00:00:00.000Z',
    ack: false, ackDeadline: null,
    workerId: null, assignedAt: null, excludeWorker: null, requeuedAt: null, error: null,
    ...extra,
  };
}

function worker(id, extra = {}) {
  return { id, workerId: id, host: 'h', port: 9500, status: 'online', ...extra };
}

async function getWorkers(store) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, {}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/workers`);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /workers shows the assigned task for the worker running it', async () => {
  const jobs = [{
    id: 'job_1', name: 'demo.mp4',
    tasks: [task('t1', 'transcribe', 'assigned', { workerId: 'w1', chunkIndex: 2 })],
  }];
  const workers = await getWorkers(fakeStore(jobs, [worker('w1')]));
  assert.deepEqual(workers[0].currentTask, {
    jobId: 'job_1',
    jobName: 'demo.mp4',
    taskId: 't1',
    type: 'transcribe',
    chunkIndex: 2,
    groupIndex: null,
    segmentIndex: null,
  });
});

test('GET /workers reports null currentTask for idle workers', async () => {
  const jobs = [{
    id: 'job_1', name: 'demo.mp4',
    tasks: [
      task('t1', 'transcribe', 'assigned', { workerId: 'w1', chunkIndex: 0 }),
      task('t2', 'translate', 'queued', { groupIndex: 0 }),
    ],
  }];
  const workers = await getWorkers(fakeStore(jobs, [worker('w1'), worker('w2')]));
  assert.equal(workers[0].currentTask.taskId, 't1');
  assert.equal(workers[1].currentTask, null);
});

test('GET /workers matches on the registry id when the worker never reported one', async () => {
  const jobs = [{
    id: 'job_1', name: 'demo.mp4',
    tasks: [task('t1', 'burnin', 'assigned', { workerId: 'reg-x', segmentIndex: 1 })],
  }];
  const w = worker('reg-x');
  delete w.workerId;
  const workers = await getWorkers(fakeStore(jobs, [w]));
  assert.equal(workers[0].currentTask.taskId, 't1');
  assert.equal(workers[0].currentTask.segmentIndex, 1);
});

// ---- /tasks/next carries the job's transcription engine ----
async function getNextTask(store, runner, query) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, runner));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/next${query}`);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /tasks/next passes the job engine (default faster-whisper) to the worker', async () => {
  const t = task('t1', 'transcribe', 'queued', { chunkIndex: 0 });
  const job = {
    id: 'job_1', name: 'demo.mp4', stage: 'transcribing',
    config: { engine: 'whisperjav', model: 'large-v3', sourceLang: 'en', targetLang: 'zh-CN' },
    tasks: [t],
  };
  const runnerStub = {
    claimTask() { return { job, task: t }; },
    taskInput() { return { kind: 'file', path: '/tmp/chunk.wav' }; },
  };
  const claimed = await getNextTask(fakeStore([job], []), runnerStub, '?type=transcribe&workerId=w1');
  assert.equal(claimed.taskId, 't1');
  assert.equal(claimed.engine, 'whisperjav');
  assert.equal(claimed.model, 'large-v3');
  // A job without an engine (pre-1.4) defaults to faster-whisper.
  const legacy = { ...job, config: { model: 'large-v3', sourceLang: 'auto', targetLang: 'zh-CN' } };
  const runnerLegacy = {
    claimTask() { return { job: legacy, task: t }; },
    taskInput() { return { kind: 'file', path: '/tmp/chunk.wav' }; },
  };
  const claimedLegacy = await getNextTask(fakeStore([legacy], []), runnerLegacy, '?type=transcribe&workerId=w1');
  assert.equal(claimedLegacy.engine, 'faster-whisper');
  assert.equal(claimedLegacy.sourceLang, null);
});
