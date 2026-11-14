// Sentence re-segmentation from word timestamps, plus an optional
// LLM text-only polish that must preserve segment count and boundaries.
// Word shape: { text, start, end }. Segment shape: { text, start, end, words? }.

const TERMINAL = /[.?!。！？…]+$/;
const SOFT_BREAK = /[,;:、，；：]+$/;
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF]/;

function isCjkChar(ch) {
  return CJK.test(ch);
}

/** Join words the way subtitles read: no space between two CJK chars. */
export function joinWords(words) {
  let out = '';
  for (const w of words) {
    if (!out) {
      out = w;
      continue;
    }
    const prev = out[out.length - 1];
    const next = w[0];
    out += isCjkChar(prev) && isCjkChar(next) ? w : ' ' + w;
  }
  return out;
}

/**
 * Regroup word timestamps into sentence-like segments.
 * Cuts after terminal punctuation, or when a group reaches maxWords,
 * or when its duration exceeds maxDurSec (cut at the next soft break).
 * @param {Array} segments merged segments (must carry `words`)
 * @param {Object} [opts] { maxWords, maxDurSec }
 */
export function resegmentByWords(segments, opts = {}) {
  const maxWords = opts.maxWords ?? 25;
  const maxDurSec = opts.maxDurSec ?? 8;
  const allWords = [];
  for (const seg of segments || []) {
    for (const w of seg.words || []) allWords.push(w);
  }
  if (allWords.length === 0) return segments;

  const groups = [];
  let cur = [];
  const flush = () => {
    if (cur.length === 0) return;
    groups.push({
      text: joinWords(cur.map((w) => w.text)),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      words: cur.map((w) => ({ ...w })),
    });
    cur = [];
  };
  for (const w of allWords) {
    cur.push(w);
    const dur = cur[cur.length - 1].end - cur[0].start;
    if (TERMINAL.test(w.text)) flush();
    else if (cur.length >= maxWords) flush();
    else if (dur >= maxDurSec && SOFT_BREAK.test(w.text)) flush();
  }
  flush();
  return groups;
}

/**
 * LLM text-only polish: fix punctuation/casing, keep the exact segment
 * count and timestamps. `correctFn` maps an array of texts to corrected
 * texts (e.g. a Gemini call). Returns the original segments unchanged when
 * the correction is unavailable or the count does not match.
 */
export async function llmPolishSegments(segments, correctFn) {
  if (!correctFn || segments.length === 0) return { segments, applied: false };
  let corrected;
  try {
    corrected = await correctFn(segments.map((s) => s.text));
  } catch {
    return { segments, applied: false };
  }
  if (!Array.isArray(corrected) || corrected.length !== segments.length) {
    return { segments, applied: false };
  }
  return {
    segments: segments.map((seg, i) => ({ ...seg, text: String(corrected[i]).trim() || seg.text })),
    applied: true,
  };
}
