import test from 'node:test';
import assert from 'node:assert/strict';
import { planBurnSegments, shiftSegments } from '../src/burnPlan.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 18 subtitle lines, ~2.6s each with ~1.1s gaps, over a 67.2s video. */
function makeSubs() {
  const subs = [];
  let t = 0;
  for (let i = 0; i < 18; i++) {
    subs.push({ text: `line ${i}`, start: round3(t), end: round3(t + 2.6) });
    t += 3.7;
  }
  return subs;
}

/** Assert no subtitle straddles any boundary: for every subtitle and every
 * interior boundary, the boundary is never strictly inside the subtitle. */
function assertNoStraddle(plan) {
  const boundaries = plan.slice(1).map((s) => s.start);
  for (const seg of plan) {
    for (const sub of seg.subtitles) {
      for (const b of boundaries) {
        assert.ok(!(sub.start < b && b < sub.end), `subtitle [${sub.start}, ${sub.end}] straddles boundary ${b}`);
      }
    }
  }
}

/** Assert every input subtitle appears in exactly one segment, in order. */
function assertAssignmentComplete(plan, subs) {
  const assigned = plan.flatMap((s) => s.subtitles);
  assert.equal(assigned.length, subs.length);
  assert.deepEqual(assigned.map((s) => s.text), subs.map((s) => s.text));
}

test('single segment when video is shorter than one chunk', () => {
  const subs = makeSubs();
  const plan = planBurnSegments(67.2, subs, 300);
  assert.equal(plan.length, 1);
  assert.deepEqual([plan[0].start, plan[0].end], [0, 67.2]);
  assertAssignmentComplete(plan, subs);
});

test('gap-aligned boundaries with 30s chunks on a 67.2s video', () => {
  const subs = makeSubs();
  const plan = planBurnSegments(67.2, subs, 30);
  assert.equal(plan.length, 3);
  // Boundaries snap to the nearest gap midpoints: ~29.05 and ~58.65.
  assert.ok(Math.abs(plan[1].start - 29.05) < 0.01, `boundary 1 = ${plan[1].start}`);
  assert.ok(Math.abs(plan[2].start - 58.65) < 0.01, `boundary 2 = ${plan[2].start}`);
  assert.equal(plan[2].end, 67.2);
  assertNoStraddle(plan);
  assertAssignmentComplete(plan, subs);
  // Every boundary lies inside a gap between two consecutive subtitles.
  for (const b of [plan[1].start, plan[2].start]) {
    const before = subs.filter((s) => s.end <= b).at(-1);
    const after = subs.find((s) => s.start >= b);
    assert.ok(before && after, `boundary ${b} has subtitles on both sides`);
    assert.ok(before.end <= b && b <= after.start, `boundary ${b} outside gap [${before.end}, ${after.start}]`);
  }
});

test('contiguous subtitles (no gaps) fall back to segment ends', () => {
  const subs = [];
  for (let i = 0; i < 6; i++) subs.push({ text: `s${i}`, start: i * 10, end: (i + 1) * 10 });
  subs.push({ text: 's6', start: 60, end: 67.2 });
  const plan = planBurnSegments(67.2, subs, 30);
  assert.ok(plan.length > 1, 'still splits without gaps');
  assert.deepEqual(plan.map((s) => s.start), [0, 30, 60]);
  assertNoStraddle(plan);
  assertAssignmentComplete(plan, subs);
});

test('one subtitle covering the whole video cannot split', () => {
  const subs = [{ text: 'all', start: 0, end: 67.2 }];
  const plan = planBurnSegments(67.2, subs, 30);
  assert.equal(plan.length, 1);
  assertAssignmentComplete(plan, subs);
});

test('empty subtitles give one segment', () => {
  const plan = planBurnSegments(67.2, [], 30);
  assert.deepEqual(plan, [{ index: 0, start: 0, end: 67.2, subtitles: [] }]);
});

test('overlapping subtitles never produce a boundary inside a line', () => {
  const subs = [
    { text: 'a', start: 5, end: 20 },
    { text: 'b', start: 8, end: 12 },
    { text: 'c', start: 12, end: 15 },
    { text: 'd', start: 25, end: 28 },
  ];
  const plan = planBurnSegments(30, subs, 10);
  // The only gap (15–25) midpoint 20 is inside subtitle 'a' [5,20]? No:
  // 20 is a's end, not strictly inside — but the midpoint 20 equals a.end,
  // so it is a legal boundary. Either way no straddle is allowed.
  assertNoStraddle(plan);
  assertAssignmentComplete(plan, subs);
});

test('segments tile the timeline without gaps or overlaps', () => {
  const subs = makeSubs();
  for (const chunkSec of [10, 30, 60]) {
    const plan = planBurnSegments(67.2, subs, chunkSec);
    assert.equal(plan[0].start, 0);
    assert.equal(plan.at(-1).end, 67.2);
    for (let i = 1; i < plan.length; i++) {
      assert.equal(plan[i].start, plan[i - 1].end);
    }
    assertNoStraddle(plan);
    assertAssignmentComplete(plan, subs);
  }
});

test('invalid inputs throw', () => {
  assert.throws(() => planBurnSegments(0, [], 30));
  assert.throws(() => planBurnSegments(67.2, [], 0));
  assert.throws(() => planBurnSegments(67.2, [], -5));
});

test('shiftSegments makes times segment-relative and clamps at zero', () => {
  const shifted = shiftSegments(
    [
      { text: 'a', start: 29.05, end: 31.5 },
      { text: 'b', start: 30, end: 33 },
    ],
    -29.05,
  );
  assert.deepEqual(shifted, [
    { text: 'a', start: 0, end: 2.45 },
    { text: 'b', start: 0.95, end: 3.95 },
  ]);
  // A subtitle starting before the offset clamps to 0 rather than going negative.
  assert.deepEqual(shiftSegments([{ text: 'x', start: 1, end: 2 }], -5), [{ text: 'x', start: 0, end: 0 }]);
});
