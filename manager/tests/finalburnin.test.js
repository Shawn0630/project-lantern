// Final burn-in: one worker burns the merged SRT into the whole video
// in a single ffmpeg pass (burnMode 'final'), coexisting with the
// default segmented burn-in. Covers the job option, the synthesize
// switch, task input/completion, and the HTTP plumbing (claim, input
// parts, result-file upload). The worker-side encode itself is covered
// by worker/tests/test_burnin.py; the happy path here runs the real
// manager synthesize() against a real ffmpeg-generated video.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runner } from '../src/pipeline.js';
import { Store } from '../src/store.js';
import { createRouter } from '../src/routes.js';
import { toSrt } from '../src/srt.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

const SEGS = [
  { text: '你好世界', start: 0.2, end: 0.9 },
  { text: '再见', start: 1.1, end: 1.9 },
];

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

/** A job faked into the synthesizing stage with translated segments. */
function makeSynthJob(store, runner, videoFile, burnMode) {
  const job = runner.createJob(
    { sourceLang: 'en', targetLang: 'zh-CN', translate: 'true', burnIn: 'true', burnMode },
    { path: videoFile, originalName: 'clip.mp4' },
  );
  job.stage = 'synthesizing';
  job.hasVideo = true;
  job.duration = 2;
  job.videoInfo = { fps: 10, width: 128, height: 72, videoCodec: 'h264', audioBitrate: 128000 };
  store.writeJsonAtomic(store.jobPath(job.id, 'resegmented.json'), { segments: SEGS });
  store.writeJsonAtomic(store.jobPath(job.id, 'translated.json'), { segments: SEGS });
  fs.writeFileSync(store.jobPath(job.id, 'translated.srt'), toSrt(SEGS));
  job.outputs.translatedSrt = 'translated.srt';
  store.saveJob(job);
  return job;
}

function withStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-finalburn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const runner = new Runner(store, { env: {} });
  return { dir, store, runner };
}

// ---- job option ----

test('buildJobConfig defaults burnMode to segmented and validates it', (t) => {
  const { dir, store, runner } = withStore(t);
  const input = path.join(dir, 'v.mp4');
  fs.writeFileSync(input, '');
  const job = runner.createJob({}, { path: input, originalName: 'v.mp4' });
  assert.equal(job.config.burnMode, 'segmented');
  const input2 = path.join(dir, 'v2.mp4');
  fs.writeFileSync(input2, '');
  const job2 = runner.createJob({ burnMode: 'final' }, { path: input2, originalName: 'v2.mp4' });
  assert.equal(job2.config.burnMode, 'final');
  const input3 = path.join(dir, 'v3.mp4');
  fs.writeFileSync(input3, '');
  assert.throws(
    () => runner.createJob({ burnMode: 'whole' }, { path: input3, originalName: 'v3.mp4' }),
    /unknown burn mode: whole/,
  );
});

// ---- task input / completion ----

test('final-burnin taskInput payload carries the original video + total ASS, no trim', (t) => {
  const { runner } = withStore(t);
  const job = {
    id: 'job_x',
    duration: 67.2,
    videoInfo: { fps: 30, width: 640, height: 360, videoCodec: 'h264', audioBitrate: 128000 },
    inputFile: 'input/clip.mp4',
    finalAssFile: 'burn/final.ass',
    tasks: [],
    config: {},
  };
  const input = runner.taskInput(job, { id: 'task_9', type: 'final-burnin' });
  assert.equal(input.kind, 'json');
  const p = input.payload;
  assert.equal(p.type, 'final-burnin');
  assert.equal(p.videoUrl, '/api/tasks/task_9/input?part=video');
  assert.equal(p.assUrl, '/api/tasks/task_9/input?part=ass');
  assert.ok(!('trimStart' in p), 'whole-video burn has no trim');
  assert.equal(p.duration, 67.2);
  assert.equal(p.crf, 20);
  assert.equal(p.fps, 30);
  assert.equal(p.width, 640);
  assert.equal(p.height, 360);
  assert.equal(p.videoCodec, 'h264');
  assert.equal(p.audioBitrate, 128000);
});

test('planFinalBurn writes one total ASS with absolute times and one task', { skip: !HAS_FFMPEG }, async (t) => {
  const { dir, store, runner } = withStore(t);
  const job = makeSynthJob(store, runner, makeTestVideo(dir), 'final');
  await runner.planFinalBurn(job, SEGS);
  assert.equal(job.finalAssFile, 'burn/final.ass');
  const ass = fs.readFileSync(store.jobPath(job.id, 'burn', 'final.ass'), 'utf8');
  assert.match(ass, /你好世界/);
  assert.match(ass, /再见/);
  // Absolute times, not shifted: first line starts at 0:00:00.20.
  assert.match(ass, /Dialogue: 0,0:00:00\.20,0:00:00\.90,Default,,0,0,0,,你好世界/);
  assert.equal(job.tasks.filter((x) => x.type === 'final-burnin').length, 1);
  assert.equal(job.tasks[0].state, 'queued');
});

test('completeTask rejects a final-burnin result without a file, accepts one with it', { skip: !HAS_FFMPEG }, (t) => {
  const { dir, store, runner } = withStore(t);
  const job = makeSynthJob(store, runner, makeTestVideo(dir), 'final');
  const task = runner.newTask('final-burnin');
  task.state = 'assigned';
  job.tasks.push(task);
  assert.throws(
    () => runner.completeTask(job, task, { status: 'done', result: {} }),
    /bad final burn-in result: missing file/,
  );
  assert.throws(
    () => runner.completeTask(job, task, { status: 'done', result: { file: 'results/final-burnin.mp4' } }),
    /bad final burn-in result: file missing/,
  );
  fs.writeFileSync(store.jobPath(job.id, 'results', 'final-burnin.mp4'), 'fake burned video');
  runner.completeTask(job, task, { status: 'done', result: { file: 'results/final-burnin.mp4' } });
  assert.equal(task.state, 'done');
});

// ---- synthesize switch (real ffmpeg video) ----

test('synthesize in final mode plans, waits, then finishes the whole-video burn', { skip: !HAS_FFMPEG }, async (t) => {
  const { dir, store, runner } = withStore(t);
  const job = makeSynthJob(store, runner, makeTestVideo(dir), 'final');
  // First tick: plans the task and waits.
  await runner.synthesize(job);
  assert.equal(job.finalAssFile, 'burn/final.ass');
  assert.equal(job.tasks.length, 1);
  assert.equal(job.tasks[0].type, 'final-burnin');
  // Still waiting while the task is queued/assigned.
  await runner.synthesize(job);
  assert.equal(job.outputs.video, undefined);
  // Simulate the worker: the burned whole video lands in results/.
  const task = job.tasks[0];
  task.state = 'assigned';
  task.workerId = 'w1';
  fs.copyFileSync(
    store.jobPath(job.id, job.inputFile),
    store.jobPath(job.id, 'results', 'final-burnin.mp4'),
  );
  runner.completeTask(job, task, { status: 'done', result: { file: 'results/final-burnin.mp4' } });
  // Final tick: moves the burn into place, muxes soft subs, done.
  await runner.synthesize(job);
  assert.equal(job.outputs.video, 'video.mp4');
  assert.ok(fs.existsSync(store.jobPath(job.id, 'video.mp4')));
  assert.equal(job.outputs.softVideo, 'soft.mp4');
  assert.ok(fs.existsSync(store.jobPath(job.id, 'soft.mp4')));
  assert.equal(job.stage, 'done');
});

test('synthesize in final mode fails the job when the burn-in task fails', { skip: !HAS_FFMPEG }, async (t) => {
  const { dir, store, runner } = withStore(t);
  const job = makeSynthJob(store, runner, makeTestVideo(dir), 'final');
  await runner.synthesize(job);
  const task = job.tasks[0];
  task.state = 'failed';
  await assert.rejects(() => runner.synthesize(job), /a final burn-in task failed/);
});

test('synthesize in segmented mode (default) still plans segments, not a final task', { skip: !HAS_FFMPEG }, async (t) => {
  const { dir, store, runner } = withStore(t);
  const job = makeSynthJob(store, runner, makeTestVideo(dir), 'segmented');
  await runner.synthesize(job);
  assert.equal(job.finalAssFile, undefined);
  assert.equal(job.tasks.filter((x) => x.type === 'final-burnin').length, 0);
  assert.ok(job.tasks.some((x) => x.type === 'burnin'));
  assert.ok(job.burnSegments.length >= 1);
});

// ---- HTTP plumbing: claim, input parts, result-file ----

function makeApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-finalburn-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const runner = new Runner(store, { env: {} });
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(store, runner));
  return { dir, store, runner, app };
}

async function boot(ctx) {
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...ctx, server, base,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

test('GET /tasks/next accepts final-burnin and rejects unknown types', { skip: !HAS_FFMPEG }, async (t) => {
  const ctx = await boot(makeApp(t));
  try {
    const job = makeSynthJob(ctx.store, ctx.runner, makeTestVideo(ctx.dir), 'final');
    await ctx.runner.planFinalBurn(job, SEGS);
    ctx.store.saveJob(job);
    const res = await fetch(`${ctx.base}/api/tasks/next?type=final-burnin&workerId=w1`);
    assert.equal(res.status, 200);
    const claimed = await res.json();
    assert.equal(claimed.taskId, job.tasks[0].id);
    assert.equal(claimed.type, 'final-burnin');
    const bad = await fetch(`${ctx.base}/api/tasks/next?type=nope&workerId=w1`);
    assert.equal(bad.status, 400);
  } finally {
    await ctx.close();
  }
});

test('GET /tasks/:id/input serves the original video and total ASS for final-burnin', { skip: !HAS_FFMPEG }, async (t) => {
  const ctx = await boot(makeApp(t));
  try {
    const job = makeSynthJob(ctx.store, ctx.runner, makeTestVideo(ctx.dir), 'final');
    await ctx.runner.planFinalBurn(job, SEGS);
    ctx.store.saveJob(job);
    const claimed = ctx.runner.claimTask('final-burnin', 'w1');
    assert.ok(claimed);
    const taskId = job.tasks[0].id;
    const videoRes = await fetch(`${ctx.base}/api/tasks/${taskId}/input?part=video`);
    assert.equal(videoRes.status, 200);
    const videoBytes = Buffer.from(await videoRes.arrayBuffer());
    assert.deepEqual(videoBytes, fs.readFileSync(ctx.store.jobPath(job.id, job.inputFile)));
    const assRes = await fetch(`${ctx.base}/api/tasks/${taskId}/input?part=ass`);
    assert.equal(assRes.status, 200);
    assert.match(await assRes.text(), /你好世界/);
    const bad = await fetch(`${ctx.base}/api/tasks/${taskId}/input?part=bogus`);
    assert.equal(bad.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /tasks/:id/result-file accepts a final-burnin upload and completes the task', { skip: !HAS_FFMPEG }, async (t) => {
  const ctx = await boot(makeApp(t));
  try {
    const job = makeSynthJob(ctx.store, ctx.runner, makeTestVideo(ctx.dir), 'final');
    await ctx.runner.planFinalBurn(job, SEGS);
    ctx.store.saveJob(job);
    ctx.runner.claimTask('final-burnin', 'w1');
    const taskId = job.tasks[0].id;
    const burned = fs.readFileSync(ctx.store.jobPath(job.id, job.inputFile));
    const fd = new FormData();
    fd.append('file', new Blob([burned], { type: 'video/mp4' }), 'final-burnin.mp4');
    fd.append('workerId', 'w1');
    fd.append('status', 'done');
    const res = await fetch(`${ctx.base}/api/tasks/${taskId}/result-file`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);
    assert.equal(ctx.store.getJob(job.id).tasks[0].state, 'done');
    // The upload lands in results/, then the pipeline tick moves it into
    // place as video.mp4 and muxes soft subs — poll for the job to finish.
    const deadline = Date.now() + 15000;
    for (;;) {
      const got = await fetch(`${ctx.base}/api/jobs/${job.id}`);
      const body = await got.json();
      if (body.stage === 'done') break;
      if (body.stage === 'failed') assert.fail(`job failed: ${body.error}`);
      if (Date.now() > deadline) assert.fail(`job did not finish, stuck at ${body.stage}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(ctx.store.jobPath(job.id, 'video.mp4')));
    assert.ok(fs.existsSync(ctx.store.jobPath(job.id, 'soft.mp4')));
  } finally {
    await ctx.close();
  }
});
