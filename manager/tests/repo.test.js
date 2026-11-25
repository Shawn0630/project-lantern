// LAN video repo: store, API (upload/list/download with Range/delete),
// job creation from a repo video, and the worker-pull path for the
// resulting transcribe tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { Runner } from '../src/pipeline.js';
import { createRouter } from '../src/routes.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-repo-'));
  const store = new Store(dataDir);
  const runner = new Runner(store, { env: {} });
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, runner));
  return { dataDir, store, runner, app };
}

async function boot(ctx) {
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, server, base, close: () => new Promise((r) => server.close(r)) };
}

function cleanup(ctx) {
  // Drop keep-alive connections first: server.close() alone waits for
  // them (Node's 5s keep-alive timeout) on every test.
  ctx.server.closeAllConnections();
  return ctx.close().then(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));
}

async function uploadRepoVideo(base, bytes, filename = 'clip.mp4') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), filename);
  return fetch(`${base}/api/repo/videos`, { method: 'POST', body: fd });
}

async function createJobFromRepo(base, videoId, extra = {}) {
  const fd = new FormData();
  fd.append('repoVideoId', videoId);
  fd.append('jobType', 'video-translation');
  fd.append('translate', 'false');
  fd.append('burnIn', 'false');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
}

function makeTestVideo(dir, name = 'clip.mp4') {
  const file = path.join(dir, name);
  const r = spawnSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x72:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`);
  return file;
}

async function waitForStage(base, jobId, want, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/jobs/${jobId}`);
    assert.equal(res.status, 200);
    const job = await res.json();
    if (job.stage === want) return job;
    if (job.stage === 'failed') assert.fail(`job failed: ${job.error}`);
    if (Date.now() > deadline) assert.fail(`job did not reach ${want}, stuck at ${job.stage}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- store ----
test('store: repo videos round-trip, newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-repo-store-'));
  try {
    const store = new Store(dir);
    assert.deepEqual(store.listRepoVideos(), []);
    const a = { id: 'video_a', filename: 'a.mp4', storedName: 'video_a.mp4', size: 10, uploadedAt: '2026-11-25T00:00:00.000Z' };
    const b = { id: 'video_b', filename: 'b.mp4', storedName: 'video_b.mp4', size: 20, uploadedAt: '2026-11-25T00:01:00.000Z' };
    store.addRepoVideo(a);
    store.addRepoVideo(b);
    assert.deepEqual(store.listRepoVideos().map((v) => v.id), ['video_b', 'video_a']);
    assert.equal(store.getRepoVideo('video_a').filename, 'a.mp4');
    assert.equal(store.getRepoVideo('nope'), null);
    assert.equal(store.getRepoVideo('../x'), null);
    assert.equal(store.repoVideoPath(a), path.join(dir, 'repo', 'video_a.mp4'));
    assert.equal(store.removeRepoVideo('video_a').id, 'video_a');
    assert.equal(store.removeRepoVideo('video_a'), null);
    assert.deepEqual(store.listRepoVideos().map((v) => v.id), ['video_b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- repo API ----
test('POST /repo/videos stores the file and returns its record', async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const bytes = Buffer.from('0123456789AB');
    const res = await uploadRepoVideo(base, bytes, 'clip.mp4');
    assert.equal(res.status, 201);
    const video = await res.json();
    assert.equal(video.filename, 'clip.mp4');
    assert.equal(video.size, bytes.length);
    assert.ok(video.id.startsWith('video_'));
    assert.ok(video.uploadedAt);
    assert.deepEqual(fs.readFileSync(ctx.store.repoVideoPath(video)), bytes);
    const list = await (await fetch(`${base}/api/repo/videos`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, video.id);
  } finally {
    await cleanup(ctx);
  }
});

test('POST /repo/videos rejects a missing file and non-multipart bodies', async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const fd = new FormData();
    fd.append('note', 'no file here');
    const res = await fetch(`${base}/api/repo/videos`, { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    const plain = await fetch(`${base}/api/repo/videos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(plain.status, 400);
  } finally {
    await cleanup(ctx);
  }
});

test('GET /repo/videos/:id serves the whole file and byte ranges', async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const bytes = Buffer.from('0123456789AB');
    const video = await (await uploadRepoVideo(base, bytes)).json();
    const full = await fetch(`${base}/api/repo/videos/${video.id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const slice = await fetch(`${base}/api/repo/videos/${video.id}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get('content-range'), `bytes 2-5/${bytes.length}`);
    assert.deepEqual(Buffer.from(await slice.arrayBuffer()), Buffer.from('2345'));
    const tail = await fetch(`${base}/api/repo/videos/${video.id}`, { headers: { Range: 'bytes=8-' } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes 8-11/${bytes.length}`);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), Buffer.from('89AB'));
    const suffix = await fetch(`${base}/api/repo/videos/${video.id}`, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.from('9AB'));
    const bad = await fetch(`${base}/api/repo/videos/${video.id}`, { headers: { Range: 'bytes=99-100' } });
    assert.equal(bad.status, 416);
    const missing = await fetch(`${base}/api/repo/videos/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await cleanup(ctx);
  }
});

test('DELETE /repo/videos/:id removes the record and the file', async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const video = await (await uploadRepoVideo(base, Buffer.from('data'))).json();
    const file = ctx.store.repoVideoPath(video);
    assert.ok(fs.existsSync(file));
    const res = await fetch(`${base}/api/repo/videos/${video.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(ctx.store.getRepoVideo(video.id), null);
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(await (await fetch(`${base}/api/repo/videos`)).json(), []);
    const again = await fetch(`${base}/api/repo/videos/${video.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  } finally {
    await cleanup(ctx);
  }
});

// ---- job creation from a repo video ----
test('POST /api/jobs with repoVideoId creates a job linked to the repo file', { skip: !HAS_FFMPEG }, async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const videoFile = makeTestVideo(ctx.dataDir);
    const video = await (await uploadRepoVideo(base, fs.readFileSync(videoFile), 'clip.mp4')).json();
    const res = await createJobFromRepo(base, video.id);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    assert.equal(job.name, 'clip.mp4');
    assert.equal(job.repoVideoId, video.id);
    // The job input is a hard link to the repo file: same inode, no copy.
    const inputPath = ctx.store.jobPath(id, job.inputFile);
    assert.equal(fs.statSync(inputPath).ino, fs.statSync(ctx.store.repoVideoPath(video)).ino);
    // prepare() runs on the tick: one 2s clip -> one chunk, one transcribe task.
    const ready = await waitForStage(base, id, 'transcribing');
    assert.equal(ready.chunks.length, 1);
    assert.equal(ready.tasks.length, 1);
    assert.equal(ready.tasks[0].type, 'transcribe');
  } finally {
    await cleanup(ctx);
  }
});

test('job from a repo video keeps working after the repo video is deleted', { skip: !HAS_FFMPEG }, async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const videoFile = makeTestVideo(ctx.dataDir);
    const video = await (await uploadRepoVideo(base, fs.readFileSync(videoFile), 'clip.mp4')).json();
    // Create the job without the route's background tick so the delete
    // deterministically lands before prepare() reads the input.
    const job = ctx.runner.createJobFromRepo({ translate: 'false', burnIn: 'false' }, video);
    const inputPath = ctx.store.jobPath(job.id, job.inputFile);
    const before = fs.readFileSync(inputPath);
    const del = await fetch(`${base}/api/repo/videos/${video.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(fs.readFileSync(inputPath), before);
    await ctx.runner.prepare(job);
    assert.equal(job.stage, 'transcribing');
    assert.equal(job.chunks.length, 1);
  } finally {
    await cleanup(ctx);
  }
});

test('POST /api/jobs rejects both a file and repoVideoId, and an unknown repo video', async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const fd = new FormData();
    fd.append('repoVideoId', 'video_nope');
    const missing = await fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
    assert.equal(missing.status, 404);
    const both = new FormData();
    const video = await (await uploadRepoVideo(base, Buffer.from('data'))).json();
    both.append('repoVideoId', video.id);
    both.append('video', new Blob([Buffer.from('x')]), 'clip.mp4');
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: both });
    assert.equal(res.status, 400);
    // The uploaded temp file is cleaned up, not left in uploads/.
    assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'uploads')), []);
    const neither = new FormData();
    neither.append('jobType', 'video-translation');
    const res2 = await fetch(`${base}/api/jobs`, { method: 'POST', body: neither });
    assert.equal(res2.status, 400);
  } finally {
    await cleanup(ctx);
  }
});

test('upload flow is unchanged: POST /api/jobs with a file still works', { skip: !HAS_FFMPEG }, async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const videoFile = makeTestVideo(ctx.dataDir);
    const fd = new FormData();
    fd.append('jobType', 'video-translation');
    fd.append('translate', 'false');
    fd.append('burnIn', 'false');
    fd.append('video', new Blob([fs.readFileSync(videoFile)]), 'clip.mp4');
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const job = await waitForStage(base, id, 'transcribing');
    assert.equal(job.repoVideoId, undefined);
    assert.equal(job.chunks.length, 1);
  } finally {
    await cleanup(ctx);
  }
});

// ---- worker-pull path for a repo job ----
test('a worker can claim and download a transcribe chunk from a repo job', { skip: !HAS_FFMPEG }, async () => {
  const ctx = await boot(makeApp());
  const { base } = ctx;
  try {
    const videoFile = makeTestVideo(ctx.dataDir);
    const video = await (await uploadRepoVideo(base, fs.readFileSync(videoFile), 'clip.mp4')).json();
    const res = await createJobFromRepo(base, video.id);
    assert.equal(res.status, 201);
    const { id: jobId } = await res.json();
    await waitForStage(base, jobId, 'transcribing');
    const claim = await fetch(`${base}/api/tasks/next?type=transcribe&workerId=e2e-w1`);
    assert.equal(claim.status, 200);
    const task = await claim.json();
    assert.equal(task.jobId, jobId);
    assert.equal(task.type, 'transcribe');
    assert.equal(task.inputKind, 'file');
    const ack = await fetch(`${base}/api/tasks/${task.taskId}/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'e2e-w1' }),
    });
    assert.equal(ack.status, 200);
    const input = await fetch(`${base}${task.inputUrl}`);
    assert.equal(input.status, 200);
    const wav = Buffer.from(await input.arrayBuffer());
    assert.ok(wav.length > 0);
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  } finally {
    await cleanup(ctx);
  }
});
