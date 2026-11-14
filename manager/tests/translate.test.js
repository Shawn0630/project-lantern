import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSegments, verifyTranslateResult, DEFAULT_GROUP_SIZE } from '../src/translate.js';
import { buildTranslatePrompt, parseNumberedLines } from '../src/llm.js';

const segs = (n) => Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, start: i, end: i + 1 }));

test('grouping splits into ~20 per task', () => {
  assert.equal(DEFAULT_GROUP_SIZE, 20);
  const groups = groupSegments(segs(45));
  assert.equal(groups.length, 3);
  assert.equal(groups[0].segments.length, 20);
  assert.equal(groups[1].segments.length, 20);
  assert.equal(groups[2].segments.length, 5);
  assert.equal(groups[2].segments[0].index, 40);
  assert.deepEqual(groupSegments(segs(0)), []);
  assert.equal(groupSegments(segs(1)).length, 1);
});

test('verifyTranslateResult accepts exact counts, rejects the rest', () => {
  const group = groupSegments(segs(3))[0];
  assert.deepEqual(verifyTranslateResult(group, ['a', 'b', 'c']), { ok: true });
  assert.equal(verifyTranslateResult(group, ['a', 'b']).ok, false);
  assert.equal(verifyTranslateResult(group, ['a', 'b', 'c', 'd']).ok, false);
  assert.equal(verifyTranslateResult(group, ['a', '', 'c']).ok, false);
  assert.equal(verifyTranslateResult(group, 'not an array').ok, false);
});

test('numbered prompt + parse round-trip', () => {
  const lines = ['Hello world', 'How are you?'];
  const prompt = buildTranslatePrompt(lines, 'en', 'zh-CN');
  assert.match(prompt, /1\. Hello world/);
  assert.match(prompt, /2\. How are you\?/);
  const parsed = parseNumberedLines('1. 你好世界\n2. 你好吗？', 2);
  assert.deepEqual(parsed, ['你好世界', '你好吗？']);
});

test('parseNumberedLines tolerates blank lines and ) numbering', () => {
  assert.deepEqual(parseNumberedLines('\n1) 第一行\n\n2) 第二行\n', 2), ['第一行', '第二行']);
  assert.throws(() => parseNumberedLines('1. only one', 2), /line count mismatch/);
  assert.throws(() => parseNumberedLines('1. a\n2. b\n3. c', 2), /line count mismatch/);
});
