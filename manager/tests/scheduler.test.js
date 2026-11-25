// Scheduler behavior: capabilities, weights, ack, per-stage retries,
// concurrency cap, boot reconciliation. (No architecture change — all
// worker-pull, file state.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner, RETRY_BUDGET, ACK_TIMEOUT_MS } from '../src/pipeline.js';

const T0 = '2026-11-14T00:00:00.000Z';
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

function fakeStore(jobs = [], workers = []) {
  return {
    jobs,
    workers,
    listJobs() { return this.jobs; },
    saveJob() {},
    listWorkers() { return this.workers; },
    saveWorkers(w) { this.workers = w; },
  };
}

function makeTask(id, type, state = 'queued', extra = {}) {
  return {
    id, type, state,
    attempts: 0, weight: 0, queuedAt: T0,
    ack: false, ackDeadline: null,
    workerId: null, assignedAt: null, excludeWorker: null, requeuedAt: null, error: null,
    ...extra,
  };
}

function makeJob(id, stage, tasks, createdAt = T0) {
  return { id, stage, tasks, createdAt, logs: [], config: {} };
}

function makeWorker(workerId, extra = {}) {
  return {
    id: `reg-${workerId}`, workerId, host: 'h', port: 9500,
    status: 'online', lastSeen: iso(NOW), load: 0,
    ...extra,
  };
}

function runner(jobs = [], workers = [], env = {}) {
  return new Runner(fakeStore(jobs, workers), { env });
}

// ---- capabilities ----
test('claimTask only offers task kinds the worker is capable of', () => {
  const t1 = makeTask('t1', 'transcribe');
  const t2 = makeTask('t2', 'translate');
  const job = makeJob('j1', 'transcribing', [t1, t2]);
  const r = runner([job], [makeWorker('w1', { capabilities: ['transcribe'] })]);
  assert.equal(r.claimTask('translate', 'w1'), null);
  const claimed = r.claimTask('transcribe', 'w1');
  assert.equal(claimed.task.id, 't1');
});

test('claimTask offers everything to unknown workers and workers without capabilities', () => {
  const t2 = makeTask('t2', 'translate');
  const job = makeJob('j1', 'translating', [t2]);
  // A global key is configured, so the translate claim resolves one.
  const r = runner([job], [makeWorker('w1', { capabilities: null })], { LLM_API_KEY: 'g-key' });
  assert.equal(r.claimTask('translate', 'nobody').task.id, 't2');
  const r2 = runner([makeJob('j2', 'translating', [makeTask('t3', 'translate')])],
    [makeWorker('w1', { capabilities: null })], { LLM_API_KEY: 'g-key' });
  assert.equal(r2.claimTask('translate', 'w1').task.id, 't3');
});

test('a worker with an empty capability list is offered nothing', () => {
  const job = makeJob('j1', 'transcribing', [makeTask('t1', 'transcribe')]);
  const r = runner([job], [makeWorker('w1', { capabilities: [] })]);
  assert.equal(r.claimTask('transcribe', 'w1'), null);
});

// ---- weights ----
test('a started job outranks a fresh job at equal base weight', () => {
  const fresh = makeJob('ja', 'transcribing',
    [makeTask('ta', 'transcribe', 'queued', { queuedAt: iso(NOW - 60000) })], iso(NOW - 60000));
  const started = makeJob('jb', 'transcribing', [
    makeTask('done1', 'transcribe', 'done'),
    makeTask('tb', 'transcribe', 'queued', { queuedAt: iso(NOW) }),
  ], iso(NOW));
  const r = runner([fresh, started], []);
  assert.equal(r.claimTask('transcribe', 'w').task.id, 'tb');
});

test('explicit base weight beats the started-job bonus', () => {
  const started = makeJob('jb', 'transcribing', [
    makeTask('done1', 'transcribe', 'done'),
    makeTask('tb', 'transcribe', 'queued'),
  ]);
  const heavy = makeJob('jc', 'transcribing',
    [makeTask('tc', 'transcribe', 'queued', { weight: 5 })]);
  const r = runner([started, heavy], []);
  assert.equal(r.claimTask('transcribe', 'w').task.id, 'tc');
});

test('equal weight orders by queuedAt, oldest first', () => {
  const job = makeJob('j1', 'transcribing', [
    makeTask('t2', 'transcribe', 'queued', { queuedAt: iso(NOW) }),
    makeTask('t1', 'transcribe', 'queued', { queuedAt: iso(NOW - 60000) }),
  ]);
  const r = runner([job], []);
  assert.equal(r.claimTask('transcribe', 'w').task.id, 't1');
});

// ---- ack ----
test('claim reserves without counting an attempt; ack counts exactly one', () => {
  const task = makeTask('t1', 'transcribe');
  const job = makeJob('j1', 'transcribing', [task]);
  const r = runner([job], []);
  const claimed = r.claimTask('transcribe', 'w1');
  assert.equal(claimed.task.state, 'assigned');
  assert.equal(claimed.task.ack, false);
  assert.equal(claimed.task.attempts, 0);
  const deadline = new Date(claimed.task.ackDeadline).getTime();
  assert.ok(deadline - Date.now() > ACK_TIMEOUT_MS - 5000 && deadline - Date.now() <= ACK_TIMEOUT_MS);
  r.ackTask(job, task, 'w1');
  assert.equal(task.ack, true);
  assert.equal(task.attempts, 1);
  r.ackTask(job, task, 'w1'); // idempotent
  assert.equal(task.attempts, 1);
});

test('ack rejects the wrong worker (403) and non-assigned tasks (409)', () => {
  const task = makeTask('t1', 'transcribe');
  const job = makeJob('j1', 'transcribing', [task]);
  const r = runner([job], []);
  assert.throws(() => r.ackTask(job, task, 'w1'), (e) => e.status === 409);
  r.claimTask('transcribe', 'w1');
  assert.throws(() => r.ackTask(job, task, 'w2'), (e) => e.status === 403);
});

// ---- un-acked sweep ----
test('sweepUnacked re-offers un-acked assignments without consuming an attempt', () => {
  const task = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 60000),
    ackDeadline: iso(NOW - 15000), ack: false,
  });
  const job = makeJob('j1', 'transcribing', [task]);
  const r = runner([job], []);
  assert.equal(r.sweepUnacked(NOW), 1);
  assert.equal(task.state, 'queued');
  assert.equal(task.attempts, 0);
  assert.equal(task.excludeWorker, 'w1');
  assert.equal(task.ack, false);
});

test('sweepUnacked leaves acked tasks and unexpired assignments alone', () => {
  const acked = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 60000),
    ackDeadline: iso(NOW - 15000), ack: true, attempts: 1,
  });
  const fresh = makeTask('t2', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW),
    ackDeadline: iso(NOW + ACK_TIMEOUT_MS), ack: false,
  });
  const job = makeJob('j1', 'transcribing', [acked, fresh]);
  const r = runner([job], []);
  assert.equal(r.sweepUnacked(NOW), 0);
  assert.equal(acked.state, 'assigned');
  assert.equal(fresh.state, 'assigned');
});

// ---- per-stage retry budgets ----
test('retry budgets are per stage: transcribe 2, translate 3, burnin 1', () => {
  assert.deepEqual(RETRY_BUDGET, { transcribe: 2, translate: 3, burnin: 1 });
});

function failNTimes(r, job, task, n, workerPrefix = 'w') {
  for (let i = 0; i < n; i++) {
    const wid = `${workerPrefix}${i}`;
    const claimed = r.claimTask(task.type, wid);
    assert.ok(claimed, `claim ${i + 1} should succeed`);
    r.ackTask(job, task, wid);
    r.completeTask(job, task, { status: 'failed', error: 'boom' });
  }
}

test('transcribe fails permanently after 2 attempts', () => {
  const task = makeTask('t1', 'transcribe');
  const job = makeJob('j1', 'transcribing', [task]);
  const r = runner([job], []);
  failNTimes(r, job, task, 1);
  assert.equal(task.state, 'queued');
  failNTimes(r, job, task, 1, 'x');
  assert.equal(task.state, 'failed');
});

test('translate survives 2 failures and fails on the 3rd', () => {
  const task = makeTask('t1', 'translate');
  const job = makeJob('j1', 'translating', [task]);
  const r = runner([job], [], { LLM_API_KEY: 'g-key' });
  failNTimes(r, job, task, 2);
  assert.equal(task.state, 'queued');
  assert.equal(task.attempts, 2);
  failNTimes(r, job, task, 1, 'x');
  assert.equal(task.state, 'failed');
});

test('burnin fails permanently on the first failure', () => {
  const task = makeTask('t1', 'burnin');
  const job = makeJob('j1', 'synthesizing', [task]);
  const r = runner([job], []);
  failNTimes(r, job, task, 1);
  assert.equal(task.state, 'failed');
});

// ---- concurrency cap ----
test('in-flight cap blocks further claims', () => {
  const job = makeJob('j1', 'transcribing', [
    makeTask('t1', 'transcribe'),
    makeTask('t2', 'transcribe'),
  ]);
  const r = runner([job], [], { MAX_IN_FLIGHT_TASKS: '1' });
  assert.equal(r.maxInFlight, 1);
  assert.ok(r.claimTask('transcribe', 'w1'));
  assert.equal(r.claimTask('transcribe', 'w2'), null);
});

test('default in-flight cap is 16', () => {
  const r = runner([], [], {});
  assert.equal(r.maxInFlight, 16);
});

// ---- boot reconciliation / liveness ----
test('verifyAssignedWorkers re-queues tasks of silent workers and marks them offline', () => {
  const dead = makeWorker('dead', { lastSeen: iso(NOW - 60000) });
  const live = makeWorker('live', { lastSeen: iso(NOW - 5000) });
  const tDead = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'dead', assignedAt: iso(NOW - 60000), ack: true, attempts: 1,
  });
  const tLive = makeTask('t2', 'transcribe', 'assigned', {
    workerId: 'live', assignedAt: iso(NOW - 5000), ack: true, attempts: 1,
  });
  const tGhost = makeTask('t3', 'transcribe', 'assigned', {
    workerId: 'ghost', assignedAt: iso(NOW - 60000), ack: true, attempts: 1,
  });
  const job = makeJob('j1', 'transcribing', [tDead, tLive, tGhost]);
  const r = runner([job], [dead, live]);
  assert.equal(r.verifyAssignedWorkers(NOW), 2);
  assert.equal(tDead.state, 'queued');
  assert.equal(tLive.state, 'assigned');
  assert.equal(tGhost.state, 'queued');
  assert.equal(dead.status, 'offline');
  assert.equal(live.status, 'online');
});

test('requeueWorkerTasks re-offers only that worker\'s assigned tasks', () => {
  const tMine = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 5000), ack: true, attempts: 1,
  });
  const tOther = makeTask('t2', 'transcribe', 'assigned', {
    workerId: 'w2', assignedAt: iso(NOW - 5000), ack: true, attempts: 1,
  });
  const tQueued = makeTask('t3', 'transcribe', 'queued', { workerId: null });
  const job = makeJob('j1', 'transcribing', [tMine, tOther, tQueued]);
  const r = runner([job], [makeWorker('w1'), makeWorker('w2')]);
  assert.equal(r.requeueWorkerTasks('w1', 'worker restarted'), 1);
  assert.equal(tMine.state, 'queued');
  assert.equal(tMine.excludeWorker, 'w1');
  assert.equal(tOther.state, 'assigned');
  assert.equal(tQueued.state, 'queued');
});

test('requeueWorkerTasks fails a task whose retry budget is spent', () => {
  const spent = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 5000), ack: true, attempts: 2,
  });
  const job = makeJob('j1', 'transcribing', [spent]);
  const r = runner([job], [makeWorker('w1')]);
  assert.equal(r.requeueWorkerTasks('w1'), 1);
  assert.equal(spent.state, 'failed');
});

test('reconcileOnBoot sweeps stale assignments immediately', () => {
  const stale = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 20 * 60 * 1000), ack: true, attempts: 1,
  });
  const fresh = makeTask('t2', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 60000), ack: true, attempts: 1,
  });
  const job = makeJob('j1', 'transcribing', [stale, fresh]);
  const r = runner([job], []);
  // Freeze time for the sweep: reconcileOnBoot uses Date.now() internally,
  // so set assignedAt relative to the real clock (done above).
  r.reconcileOnBoot();
  assert.equal(stale.state, 'queued');
  assert.equal(fresh.state, 'assigned');
});

test('reconcileOnBoot fails a stale task whose budget is spent', () => {
  const stale = makeTask('t1', 'transcribe', 'assigned', {
    workerId: 'w1', assignedAt: iso(NOW - 20 * 60 * 1000), ack: true, attempts: 2,
  });
  const job = makeJob('j1', 'transcribing', [stale]);
  const r = runner([job], []);
  r.reconcileOnBoot();
  assert.equal(stale.state, 'failed');
});

// ---- exclusion expiry (existing behavior preserved) ----
test('failed-task worker exclusion expires after 60 s', () => {
  const task = makeTask('t1', 'transcribe');
  const job = makeJob('j1', 'transcribing', [task]);
  const r = runner([job], []);
  r.claimTask('transcribe', 'w1');
  r.ackTask(job, task, 'w1');
  r.completeTask(job, task, { status: 'failed', error: 'boom' });
  assert.equal(task.state, 'queued');
  assert.equal(r.claimTask('transcribe', 'w1'), null);
  task.requeuedAt = iso(Date.now() - 61000);
  assert.equal(r.claimTask('transcribe', 'w1').task.id, 't1');
});

// ---- per-worker model pin ----
test('a model-pinned worker only takes transcribe tasks for its model', () => {
  const mk = (jobId, model, taskId) => {
    const job = makeJob(jobId, 'transcribing', [makeTask(taskId, 'transcribe')]);
    job.config = { model };
    return job;
  };
  const jobs = [mk('j1', 'large-v3', 't1'), mk('j2', 'large-v3-turbo', 't2')];
  const pinned = runner(jobs, [makeWorker('w1', { modelPin: 'large-v3-turbo' })]);
  assert.equal(pinned.claimTask('transcribe', 'w1').task.id, 't2');
  // A worker pinned to a model no queued job uses waits.
  const waiting = runner([mk('j3', 'large-v3', 't3')], [makeWorker('w2', { modelPin: 'large-v3-turbo' })]);
  assert.equal(waiting.claimTask('transcribe', 'w2'), null);
});

test('an unpinned worker takes any model', () => {
  const job = makeJob('j1', 'transcribing', [makeTask('t1', 'transcribe')]);
  job.config = { model: 'large-v3-turbo' };
  const r = runner([job], [makeWorker('w1')]);
  assert.equal(r.claimTask('transcribe', 'w1').task.id, 't1');
});

// ---- transcription engine (job config + per-worker engine pin + capability) ----
test('buildJobConfig stores the engine with faster-whisper default and validates it', () => {
  const r = runner([], []);
  assert.equal(r.buildJobConfig({}).engine, 'faster-whisper');
  assert.equal(r.buildJobConfig({ engine: 'whisperjav' }).engine, 'whisperjav');
  assert.throws(() => r.buildJobConfig({ engine: 'nope' }), /unknown transcription engine: nope/);
});

test('an engine-pinned worker only takes transcribe tasks for its engine', () => {
  const mk = (jobId, engine, taskId) => {
    const job = makeJob(jobId, 'transcribing', [makeTask(taskId, 'transcribe')]);
    job.config = { engine, model: 'large-v3' };
    return job;
  };
  const jobs = [mk('j1', 'faster-whisper', 't1'), mk('j2', 'whisperjav', 't2')];
  const pinned = runner(jobs, [makeWorker('w1', { enginePin: 'whisperjav', engines: ['faster-whisper', 'whisperjav'] })]);
  assert.equal(pinned.claimTask('transcribe', 'w1').task.id, 't2');
  // A worker pinned to an engine no queued job uses waits.
  const waiting = runner([mk('j3', 'faster-whisper', 't3')], [makeWorker('w2', { enginePin: 'whisperjav', engines: ['faster-whisper', 'whisperjav'] })]);
  assert.equal(waiting.claimTask('transcribe', 'w2'), null);
  // The engine pin does not gate other task kinds.
  const translateJob = makeJob('j4', 'translating', [makeTask('t4', 'translate')]);
  const r2 = runner([translateJob], [makeWorker('w3', { enginePin: 'whisperjav', engines: ['faster-whisper', 'whisperjav'] })], { LLM_API_KEY: 'g-key' });
  assert.equal(r2.claimTask('translate', 'w3').task.id, 't4');
});

test('claimTask only offers a whisperjav job to workers that report the engine', () => {
  const mk = (jobId, engine, taskId) => {
    const job = makeJob(jobId, 'transcribing', [makeTask(taskId, 'transcribe')]);
    job.config = { engine, model: 'large-v3' };
    return job;
  };
  // A worker that only reports faster-whisper never gets a whisperjav job.
  const fwOnly = runner([mk('j1', 'whisperjav', 't1')], [makeWorker('w1', { engines: ['faster-whisper'] })]);
  assert.equal(fwOnly.claimTask('transcribe', 'w1'), null);
  // A worker that reports both engines gets it.
  const both = runner([mk('j2', 'whisperjav', 't2')], [makeWorker('w2', { engines: ['faster-whisper', 'whisperjav'] })]);
  assert.equal(both.claimTask('transcribe', 'w2').task.id, 't2');
  // A worker that never reported engines is faster-whisper-only (pre-1.4).
  const legacy = runner([mk('j3', 'whisperjav', 't3')], [makeWorker('w3')]);
  assert.equal(legacy.claimTask('transcribe', 'w3'), null);
  const legacyFw = runner([mk('j4', 'faster-whisper', 't4')], [makeWorker('w4')]);
  assert.equal(legacyFw.claimTask('transcribe', 'w4').task.id, 't4');
  // An unknown worker is offered everything (back-compat, like workerCanDo).
  const unknown = runner([mk('j5', 'whisperjav', 't5')], []);
  assert.equal(unknown.claimTask('transcribe', 'nobody').task.id, 't5');
});

// ---- per-worker LLM ----
test('workerLlm resolves per field with global fallback', () => {
  const r = runner([], [], { LLM_API_KEY: 'g-key', LLM_MODEL: 'gemini-2.5-flash' });
  assert.deepEqual(r.workerLlm(null), { apiKey: 'g-key', model: 'gemini-2.5-flash', configured: true });
  assert.deepEqual(r.workerLlm({ llm: { apiKey: 'w-key', model: null } }),
    { apiKey: 'w-key', model: 'gemini-2.5-flash', configured: true });
  assert.deepEqual(r.workerLlm({ llm: { apiKey: null, model: 'gemini-2.5-pro' } }),
    { apiKey: 'g-key', model: 'gemini-2.5-pro', configured: true });
  const r2 = runner([], [], {});
  assert.deepEqual(r2.workerLlm(null), { apiKey: '', model: 'gemini-2.5-flash', configured: false });
});

test('translationEnabled is true with a global key or any worker key', () => {
  assert.equal(runner([], [], { LLM_API_KEY: 'g' }).translationEnabled(), true);
  assert.equal(runner([], [], {}).translationEnabled(), false);
  const r = runner([], [makeWorker('w1', { llm: { apiKey: 'w-key', model: null } })], {});
  assert.equal(r.translationEnabled(), true);
  const r2 = runner([], [makeWorker('w1', { llm: { apiKey: null, model: 'gemini-2.5-pro' } })], {});
  assert.equal(r2.translationEnabled(), false);
});

test('translate tasks are only offered to workers that resolve a key', () => {
  const mkJob = () => makeJob('j1', 'translating', [makeTask('t1', 'translate')]);
  // No global key: a keyless worker waits, a worker with an override key is offered.
  const r = runner([mkJob()], [
    makeWorker('w1'),
    makeWorker('w2', { llm: { apiKey: 'w-key', model: null } }),
  ], {});
  assert.equal(r.claimTask('translate', 'w1'), null);
  assert.equal(r.claimTask('translate', 'nobody'), null);
  assert.equal(r.claimTask('translate', 'w2').task.id, 't1');
  // Global key: a worker without an override is offered, as before.
  const r2 = runner([mkJob()], [makeWorker('w1')], { LLM_API_KEY: 'g-key' });
  assert.equal(r2.claimTask('translate', 'w1').task.id, 't1');
});

test('translate task input carries the claiming worker LLM override', () => {
  const segs = { segments: [{ text: 'hello', start: 0, end: 1 }] };
  const store = {
    jobs: [], workers: [],
    listJobs() { return this.jobs; },
    saveJob() {},
    listWorkers() { return this.workers; },
    saveWorkers(w) { this.workers = w; },
    readJson() { return segs; },
    jobPath() { return '/tmp/resegmented.json'; },
  };
  const job = makeJob('j1', 'translating', [makeTask('t1', 'translate', 'assigned', { workerId: 'w2', groupIndex: 0 })]);
  job.config = { sourceLang: 'en', targetLang: 'zh-CN' };
  store.jobs = [job];
  store.workers = [
    makeWorker('w1'),
    makeWorker('w2', { llm: { apiKey: 'w-key', model: 'gemini-2.5-pro' } }),
  ];
  const r = new Runner(store, { env: { LLM_API_KEY: 'g-key', LLM_MODEL: 'gemini-2.5-flash' } });
  const input = r.taskInput(job, job.tasks[0]);
  assert.equal(input.payload.llmApiKey, 'w-key');
  assert.equal(input.payload.llmModel, 'gemini-2.5-pro');
  // A worker without an override gets the global credentials.
  job.tasks[0].workerId = 'w1';
  const input2 = r.taskInput(job, job.tasks[0]);
  assert.equal(input2.payload.llmApiKey, 'g-key');
  assert.equal(input2.payload.llmModel, 'gemini-2.5-flash');
});
