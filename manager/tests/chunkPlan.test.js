import test from 'node:test';
import assert from 'node:assert/strict';
import { planChunks } from '../src/chunkPlan.js';

test('single chunk when audio is shorter than the window', () => {
  assert.deepEqual(planChunks(300, 600, 10), [{ index: 0, start: 0, end: 300 }]);
});

test('exact window boundary gives one chunk', () => {
  assert.deepEqual(planChunks(600, 600, 10), [{ index: 0, start: 0, end: 600 }]);
});

test('multi-chunk windows with overlap', () => {
  // 1250s, 600s windows, 10s overlap: [0,600], [590,1190], [1180,1250]
  assert.deepEqual(planChunks(1250, 600, 10), [
    { index: 0, start: 0, end: 600 },
    { index: 1, start: 590, end: 1190 },
    { index: 2, start: 1180, end: 1250 },
  ]);
});

test('last chunk may be a short tail', () => {
  const chunks = planChunks(605, 600, 10);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[1], { index: 1, start: 590, end: 605 });
});

test('consecutive starts step by chunk minus overlap', () => {
  const chunks = planChunks(3600, 600, 10);
  assert.equal(chunks.length, 7);
  assert.deepEqual(chunks.map((c) => c.start), [0, 590, 1180, 1770, 2360, 2950, 3540]);
  assert.equal(chunks[6].end, 3600);
});

test('invalid inputs throw', () => {
  assert.throws(() => planChunks(0, 600, 10));
  assert.throws(() => planChunks(100, 0, 10));
  assert.throws(() => planChunks(100, 600, 600));
  assert.throws(() => planChunks(100, 600, 700));
  assert.throws(() => planChunks(100, 600, -1));
});
