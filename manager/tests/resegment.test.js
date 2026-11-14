import test from 'node:test';
import assert from 'node:assert/strict';
import { resegmentByWords, joinWords, llmPolishSegments } from '../src/resegment.js';

const w = (text, start, end) => ({ text, start, end });

test('regroups words into sentences at terminal punctuation', () => {
  const segments = [{
    text: 'x', start: 0, end: 6,
    words: [
      w('Hello', 0, 0.5), w('world.', 0.5, 1),
      w('How', 1, 1.5), w('are', 1.5, 2), w('you?', 2, 2.5),
      w('I', 2.5, 3), w('am', 3, 3.5), w('fine.', 3.5, 4),
    ],
  }];
  const out = resegmentByWords(segments);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.text), ['Hello world.', 'How are you?', 'I am fine.']);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 1);
  assert.equal(out[2].start, 2.5);
  assert.equal(out[2].end, 4);
});

test('maxWords forces a cut mid-sentence', () => {
  const words = Array.from({ length: 30 }, (_, i) => w('w' + i, i * 0.4, i * 0.4 + 0.3));
  const out = resegmentByWords([{ text: 'x', start: 0, end: 12, words }], { maxWords: 10 });
  assert.equal(out.length, 3);
  assert.equal(out[0].words.length, 10);
  assert.equal(out[2].words.length, 10);
});

test('maxDurSec cuts at the next soft break', () => {
  const words = [
    w('Alpha', 0, 1), w('beta,', 1, 2), w('gamma', 2, 3), w('delta,', 3, 4),
    w('epsilon', 4, 5), w('zeta.', 5, 6),
  ];
  const out = resegmentByWords([{ text: 'x', start: 0, end: 6, words }], { maxDurSec: 1.5 });
  assert.equal(out.length, 3);
  assert.equal(out[0].text, 'Alpha beta,');
  assert.equal(out[1].text, 'gamma delta,');
  assert.equal(out[2].text, 'epsilon zeta.');
});

test('no words returns the segments unchanged', () => {
  const segs = [{ text: 'Hello', start: 0, end: 1 }];
  assert.deepEqual(resegmentByWords(segs), segs);
  assert.deepEqual(resegmentByWords([]), []);
});

test('joinWords puts no space between CJK characters', () => {
  assert.equal(joinWords(['你好', '世界']), '你好世界');
  assert.equal(joinWords(['Hello', 'world']), 'Hello world');
  assert.equal(joinWords(['你好', 'world']), '你好 world');
});

test('llmPolishSegments keeps count and boundaries, rejects mismatches', async () => {
  const segs = [
    { text: 'hello world', start: 0, end: 1 },
    { text: 'how are you', start: 1, end: 2 },
  ];
  const ok = await llmPolishSegments(segs, async (texts) => ['Hello world.', 'How are you?']);
  assert.equal(ok.applied, true);
  assert.deepEqual(ok.segments.map((s) => s.text), ['Hello world.', 'How are you?']);
  assert.equal(ok.segments[0].start, 0);
  assert.equal(ok.segments[0].end, 1);

  const bad = await llmPolishSegments(segs, async () => ['only one line']);
  assert.equal(bad.applied, false);
  assert.deepEqual(bad.segments, segs);

  const throwing = await llmPolishSegments(segs, async () => { throw new Error('boom'); });
  assert.equal(throwing.applied, false);

  const none = await llmPolishSegments(segs, null);
  assert.equal(none.applied, false);
});
