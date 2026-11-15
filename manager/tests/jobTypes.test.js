// Job-type registry + upload validation:
//  - GET /api/job-types serves the video-translation schema
//  - POST /api/jobs accepts jobType=video-translation, defaults to it
//    when absent, and rejects unknown job types with a 400.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createRouter } from '../src/routes.js';
import { getJobType, listJobTypes } from '../src/jobTypes.js';

test('registry has exactly one enabled type: video-translation', () => {
  const types = listJobTypes();
  assert.equal(types.length, 1);
  assert.equal(types[0].id, 'video-translation');
  assert.equal(types[0].name, 'Video translation');
});

test('video-translation fields match the old form, with the same defaults', () => {
  const fields = getJobType('video-translation').fields;
  assert.deepEqual(fields.map((f) => f.key), [
    'video', 'sourceLang', 'targetLang', 'model', 'chunkMin',
    'overlapSec', 'burnChunkMin', 'translate', 'burnIn', 'bilingual',
  ]);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.video.kind, 'file');
  assert.equal(byKey.video.required, true);
  assert.equal(byKey.sourceLang.default, 'auto');
  assert.equal(byKey.targetLang.default, 'zh-CN');
  assert.equal(byKey.model.default, 'small');
  assert.equal(byKey.chunkMin.default, 10);
  assert.equal(byKey.overlapSec.default, 10);
  assert.equal(byKey.burnChunkMin.default, 5);
  assert.equal(byKey.translate.default, true);
  assert.equal(byKey.burnIn.default, true);
  assert.equal(byKey.bilingual.default, false);
  assert.deepEqual(byKey.model.options.map((o) => o.value),
    ['tiny', 'base', 'small', 'medium', 'large-v3']);
});

test('getJobType returns null for unknown ids', () => {
  assert.equal(getJobType('model-training'), null);
  assert.equal(getJobType(''), null);
});

async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-jobtypes-'));
  const runner = {
    lastFields: null,
    lastFile: null,
    createJob(fields, file) {
      this.lastFields = fields;
      this.lastFile = file;
      return { id: 'job_test1' };
    },
    async tick() {},
  };
  const store = {
    dataDir,
    saveJob() {},
    listJobs() { return []; },
    listWorkers() { return []; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, runner));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, runner, dataDir,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function uploadForm({ jobType, withFile = true } = {}) {
  const fd = new FormData();
  if (withFile) {
    fd.append('video', new Blob(['fake video bytes'], { type: 'video/mp4' }), 'demo.mp4');
  }
  if (jobType !== undefined) fd.append('jobType', jobType);
  return fd;
}

test('GET /api/job-types returns the video-translation schema', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/api/job-types`);
    assert.equal(res.status, 200);
    const types = await res.json();
    assert.equal(types.length, 1);
    assert.equal(types[0].id, 'video-translation');
    assert.equal(types[0].fields.length, 10);
    assert.equal(types[0].fields.find((f) => f.key === 'model').default, 'small');
  } finally {
    await srv.stop();
  }
});

test('POST /api/jobs with jobType=video-translation works', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/api/jobs`, { method: 'POST', body: uploadForm({ jobType: 'video-translation' }) });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, 'job_test1');
    assert.equal(srv.runner.lastFields.jobType, 'video-translation');
    assert.equal(srv.runner.lastFile.originalName, 'demo.mp4');
  } finally {
    await srv.stop();
  }
});

test('POST /api/jobs without jobType still works (backward compatible)', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/api/jobs`, { method: 'POST', body: uploadForm() });
    assert.equal(res.status, 201);
    assert.equal(srv.runner.lastFields.jobType, undefined);
  } finally {
    await srv.stop();
  }
});

test('POST /api/jobs with an unknown jobType is rejected with 400', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/api/jobs`, { method: 'POST', body: uploadForm({ jobType: 'model-training' }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unknown job type: model-training/);
    assert.equal(srv.runner.lastFields, null);
  } finally {
    await srv.stop();
  }
});

test('POST /api/jobs with jobType=video-translation but no file is rejected with 400', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/api/jobs`, { method: 'POST', body: uploadForm({ jobType: 'video-translation', withFile: false }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /missing video file/);
    assert.equal(srv.runner.lastFields, null);
  } finally {
    await srv.stop();
  }
});
