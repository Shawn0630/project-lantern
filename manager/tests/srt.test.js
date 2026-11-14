import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, parseTime, toSrt, parseSrt, toAss } from '../src/srt.js';

test('formatTime / parseTime are inverses', () => {
  assert.equal(formatTime(0), '00:00:00,000');
  assert.equal(formatTime(61.5), '00:01:01,500');
  assert.equal(formatTime(3599.999), '00:59:59,999');
  assert.equal(formatTime(3661.234), '01:01:01,234');
  assert.equal(parseTime('00:01:01,500'), 61.5);
  assert.equal(parseTime('01:01:01.234'), 3661.234);
  assert.equal(parseTime(formatTime(123.456)), 123.456);
  assert.throws(() => formatTime(-1));
  assert.throws(() => parseTime('not a time'));
});

test('SRT round-trip preserves segments', () => {
  const segs = [
    { text: 'Hello world', start: 0.5, end: 2.25 },
    { text: 'Second line\nwith a break', start: 3, end: 5.5 },
    { text: '你好世界', start: 3661.234, end: 3663 },
  ];
  const parsed = parseSrt(toSrt(segs));
  assert.deepEqual(parsed, segs);
});

test('SRT output shape', () => {
  const srt = toSrt([{ text: 'Hi', start: 1, end: 2 }]);
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
});

test('parseSrt tolerates CRLF and missing index lines', () => {
  const parsed = parseSrt('00:00:01,000 --> 00:00:02,000\r\nHi there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'Hi there');
  assert.equal(parsed[1].text, 'Bye');
});

test('ASS conversion emits a valid header and dialogue lines', () => {
  const ass = toAss([
    { text: 'Hello', start: 1, end: 2 },
    { text: '你好\n世界', start: 3, end: 4.5 },
  ]);
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /Style: Default,sans-serif,22/);
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:02\.00,Default,,0,0,0,,Hello/);
  assert.match(ass, /Dialogue: 0,0:00:03\.00,0:00:04\.50,Default,,0,0,0,,你好\\N世界/);
});
