import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChunks, similarity, normalizeToken } from '../src/merge.js';

const words = (text, start, step = 0.5) => {
  // Build word timestamps for a space-separated phrase, one word per `step` seconds.
  const out = [];
  let t = start;
  for (const w of text.split(' ')) {
    out.push({ text: w, start: t, end: t + step });
    t += step;
  }
  return out;
};

const seg = (text, start, end, withWords = false) => ({
  text,
  start,
  end,
  ...(withWords ? { words: words(text, start) } : {}),
});

test('single chunk passes through with offset applied', () => {
  const out = mergeChunks([{ offset: 5, segments: [seg('hello world', 0, 2, true)] }], 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 5);
  assert.equal(out[0].end, 7);
  assert.equal(out[0].words[0].start, 5);
});

test('empty input and empty chunks give empty output', () => {
  assert.deepEqual(mergeChunks([], 10), []);
  assert.deepEqual(mergeChunks([{ offset: 0, segments: [] }], 10), []);
});

test('word-level duplicate overlap is deduped', () => {
  // Chunk A covers 0-12s, chunk B covers 10-22s (2s overlap here for the test).
  // Both transcribe "the quick brown fox" in the overlap region.
  const left = [
    seg('alpha beta', 0, 2, true),
    seg('the quick brown fox', 10, 12, true),
  ];
  const right = [
    seg('the quick brown fox', 0, 2, true), // chunk-relative 0-2 = absolute 10-12
    seg('jumps over', 2, 4, true),
  ];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 10, segments: right },
    ],
    10,
  );
  const texts = out.map((s) => s.text);
  assert.deepEqual(texts, ['alpha beta', 'the quick brown fox', 'jumps over']);
  // Absolute times: right chunk offset applied.
  assert.equal(out[2].start, 12);
  assert.equal(out[2].end, 14);
});

test('word-level merge cuts at the midpoint of the matched span', () => {
  const left = [
    seg('one two three four five six', 0, 6, true),
    seg('seven eight nine ten', 6, 10, true),
  ];
  const right = [
    seg('seven eight nine ten', 0, 4, true),
    seg('eleven twelve', 4, 6, true),
  ];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 6, segments: right },
    ],
    10,
  );
  const texts = out.map((s) => s.text);
  // "seven eight nine ten" appears once; tail kept.
  assert.deepEqual(texts, ['one two three four five six', 'seven eight nine ten', 'eleven twelve']);
});

test('no text match falls back to the time-boundary split', () => {
  const left = [seg('completely different words here', 0, 4, true), seg('more unrelated text', 4, 8, true)];
  const right = [seg('totally other content', 0, 4, true), seg('nothing in common', 4, 8, true)];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 6, segments: right },
    ],
    10,
  );
  // Right starts at absolute 6; left segments ending <= 6: only the first (ends 4).
  assert.deepEqual(out.map((s) => s.text), ['completely different words here', 'totally other content', 'nothing in common']);
});

test('sentence-level fuzzy match dedupes near-identical overlap', () => {
  const left = [seg('hello world this is a test', 0, 4), seg('the quick brown fox', 4, 8)];
  const right = [seg('the quick brown fox', 0, 4), seg('jumps over the lazy dog', 4, 8)];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 6, segments: right },
    ],
    10,
  );
  assert.deepEqual(out.map((s) => s.text), ['hello world this is a test', 'the quick brown fox', 'jumps over the lazy dog']);
});

test('sentence-level near match (one typo) still aligns', () => {
  assert.ok(similarity('the quick brown fox', 'the quick brown fox') > 0.99);
  assert.ok(similarity('the quick brown fox', 'the quik brown fox') > 0.7);
  assert.ok(similarity('hello world', 'goodbye moon') < 0.7);
  const left = [seg('alpha segment here', 0, 3), seg('the quik brown fox', 3, 6)];
  const right = [seg('the quick brown fox', 0, 3), seg('tail segment here', 3, 6)];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 4, segments: right },
    ],
    10,
  );
  assert.deepEqual(out.map((s) => s.text), ['alpha segment here', 'the quick brown fox', 'tail segment here']);
});

test('empty chunk in the middle is skipped', () => {
  const out = mergeChunks(
    [
      { offset: 0, segments: [seg('first part', 0, 3, true)] },
      { offset: 5, segments: [] },
      { offset: 10, segments: [seg('last part', 0, 3, true)] },
    ],
    10,
  );
  assert.deepEqual(out.map((s) => s.text), ['first part', 'last part']);
  assert.equal(out[1].start, 10);
});

test('long segment straddling the overlap boundary is still deduped', () => {
  // The right chunk's first segment is long and extends past the overlap
  // window; the aligner must still see it (it starts inside the window).
  const left = [
    seg('alpha beta gamma', 0, 3, true),
    seg('the quick brown fox', 3, 6, true),
  ];
  const right = [
    seg('the quick brown fox jumps over', 0, 8, true), // chunk-relative 0-8, absolute 4-12
    seg('the lazy dog', 8, 10, true),
  ];
  const out = mergeChunks(
    [
      { offset: 0, segments: left },
      { offset: 4, segments: right },
    ],
    5,
  );
  const texts = out.map((s) => s.text);
  assert.ok(texts.includes('alpha beta gamma'));
  assert.ok(texts.includes('the lazy dog'));
  // "the quick brown fox" must appear exactly once across the boundary.
  assert.equal(texts.filter((t) => t.includes('quick brown fox')).length, 1);
});

test('non-overlapping chunks concatenate in offset order', () => {
  const out = mergeChunks(
    [
      { offset: 20, segments: [seg('second', 0, 2)] },
      { offset: 0, segments: [seg('first', 0, 2)] },
    ],
    10,
  );
  assert.deepEqual(out.map((s) => s.text), ['first', 'second']);
});

test('normalizeToken strips punctuation and lowercases', () => {
  assert.equal(normalizeToken('Hello,'), 'hello');
  assert.equal(normalizeToken('"World!"'), 'world');
  assert.equal(normalizeToken('你好，'), '你好');
});
