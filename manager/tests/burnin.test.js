import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../src/pipeline.js';
import { Store } from '../src/store.js';
import { concatListContent, checkConcatCompatible } from '../src/ffmpeg.js';

const stubStore = {
  readJson: () => ({ segments: [] }),
  writeJsonAtomic() {},
  saveJob() {},
};

function fakeJob() {
  return {
    id: 'job_x',
    duration: 67.2,
    hasVideo: true,
    videoInfo: { fps: 30, width: 640, height: 360, videoCodec: 'h264', audioBitrate: 128000 },
    burnSegments: [
      {
        index: 0, start: 0, end: 29.05,
        file: 'burn/seg_000.mp4', assFile: 'burn/ass_000.ass',
        trimStart: 1.2, duration: 29.05, state: 'queued',
      },
    ],
    tasks: [],
    config: {},
  };
}

test('burnin taskInput payload carries both inputs and encode params', () => {
  const runner = new Runner(stubStore, { env: {} });
  const input = runner.taskInput(fakeJob(), { id: 'task_1', type: 'burnin', segmentIndex: 0 });
  assert.equal(input.kind, 'json');
  const p = input.payload;
  assert.equal(p.type, 'burnin');
  assert.equal(p.videoUrl, '/api/tasks/task_1/input?part=video');
  assert.equal(p.assUrl, '/api/tasks/task_1/input?part=ass');
  assert.equal(p.trimStart, 1.2);
  assert.equal(p.duration, 29.05);
  assert.equal(p.crf, 20);
  assert.equal(p.fps, 30);
  assert.equal(p.width, 640);
  assert.equal(p.height, 360);
  assert.equal(p.videoCodec, 'h264');
  assert.equal(p.audioBitrate, 128000);
});

test('concat list file escapes single quotes in paths', () => {
  assert.equal(
    concatListContent(['/a/b.mp4', "/c/d'e.mp4"]),
    "file '/a/b.mp4'\nfile '/c/d'\\''e.mp4'\n",
  );
});

test('checkConcatCompatible accepts matching segments', async () => {
  const probeOk = async () => ({ hasVideo: true, videoCodec: 'h264', width: 640, height: 360, fps: 30 });
  await checkConcatCompatible(
    ['a.mp4', 'b.mp4'],
    { width: 640, height: 360, fps: 30 },
    probeOk,
  );
});

test('checkConcatCompatible rejects a resized segment', async () => {
  let n = 0;
  const probeFn = async () => {
    n += 1;
    return n === 1
      ? { hasVideo: true, videoCodec: 'h264', width: 640, height: 360, fps: 30 }
      : { hasVideo: true, videoCodec: 'h264', width: 320, height: 360, fps: 30 };
  };
  await assert.rejects(
    () => checkConcatCompatible(['a.mp4', 'b.mp4'], null, probeFn),
    /burn-in segment 1 has width 320, expected 640/,
  );
});

test('checkConcatCompatible rejects an fps mismatch and a missing video stream', async () => {
  let n = 0;
  const probeFps = async () => {
    n += 1;
    return { hasVideo: true, videoCodec: 'h264', width: 640, height: 360, fps: n === 1 ? 30 : 25 };
  };
  await assert.rejects(
    () => checkConcatCompatible(['a.mp4', 'b.mp4'], null, probeFps),
    /burn-in segment 1 has fps 25, expected 30/,
  );
  const probeNoVideo = async () => ({ hasVideo: false, videoCodec: null, width: null, height: null, fps: null });
  await assert.rejects(
    () => checkConcatCompatible(['a.mp4'], null, probeNoVideo),
    /segment 0 has no video stream/,
  );
  await assert.rejects(
    () => checkConcatCompatible([], null, probeFps),
    /no burn-in segments/,
  );
});

test('createJob stores burnChunkMin with default 5 and validates it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantask-burn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const runner = new Runner(store, { env: {} });
  const input = path.join(dir, 'v.mp4');
  fs.writeFileSync(input, '');
  const job = runner.createJob(
    { sourceLang: 'en', targetLang: 'zh-CN', burnChunkMin: '0.5' },
    { path: input, originalName: 'v.mp4' },
  );
  assert.equal(job.config.burnChunkMin, 0.5);
  assert.deepEqual(job.burnSegments, []);
  const input2 = path.join(dir, 'v2.mp4');
  fs.writeFileSync(input2, '');
  assert.throws(
    () => runner.createJob({ burnChunkMin: '0.1' }, { path: input2, originalName: 'v2.mp4' }),
    /burnChunkMin must be 0.5–120/,
  );
  const job2 = runner.createJob({}, { path: input2, originalName: 'v2.mp4' });
  assert.equal(job2.config.burnChunkMin, 5);
});
