// Merge per-chunk ASR results into one timeline.
//
// Algorithm (original implementation of the widely used sliding-window
// chunk-merge approach): each chunk's segments are offset to absolute time,
// then consecutive chunks are merged pairwise. In the overlap region a
// sliding window finds the best text alignment; the merge cuts at the
// midpoint of the matched span so the duplicated overlap text appears once.
//   - word-level (segments carry word timestamps): exact token match.
//   - sentence-level (no word timestamps): fuzzy segment-text match
//     (similarity > 0.7, at least 2 matches).
//   - no match: fall back to a time-boundary split (keep left segments
//     ending before the first right segment starts).
//
// Segment shape: { text, start, end, words?: [{text, start, end}] }.
// Input segment times are chunk-relative seconds; chunk offsets are
// absolute seconds. Output segments are in absolute seconds, sorted.

const MIN_MATCH_COUNT = 2;
const FUZZY_THRESHOLD = 0.7;

/** Normalize a token for comparison: lowercase, strip surrounding punctuation. */
export function normalizeToken(word) {
  return word
    .toLowerCase()
    .replace(/^[\s.,!?;:'"()[\]{}…。、，；：？！「」『』《》〈〉·\-–—/]+|[\s.,!?;:'"()[\]{}…。、，；：？！「」『』《》〈〉·\-–—/]+$/g, '');
}

/** Levenshtein similarity ratio in [0, 1]; 1 = identical. */
export function similarity(a, b) {
  const s = a.toLowerCase().replace(/\s+/g, ' ');
  const t = b.toLowerCase().replace(/\s+/g, ' ');
  if (s === t) return 1;
  const n = s.length;
  const m = t.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

function cloneSegment(seg) {
  const out = { text: seg.text, start: seg.start, end: seg.end };
  if (Array.isArray(seg.words)) {
    out.words = seg.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
  }
  return out;
}

function offsetSegments(segments, offset) {
  return (segments || []).map((seg) => {
    const out = cloneSegment(seg);
    out.start += offset;
    out.end += offset;
    if (out.words) for (const w of out.words) { w.start += offset; w.end += offset; }
    return out;
  });
}

/** Segments of `segs` overlapping the last `duration` seconds (from the end).
 * A segment belongs to the overlap when it ends inside the window, so a
 * long segment straddling the boundary is still seen by the aligner. */
function overlapFromEnd(segs, duration) {
  if (segs.length === 0) return [];
  const threshold = segs[segs.length - 1].end - duration;
  const out = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].end > threshold) out.unshift(segs[i]);
    else break;
  }
  return out;
}

/** Segments of `segs` overlapping the first `duration` seconds (from the start).
 * A segment belongs to the overlap when it starts inside the window, so a
 * long segment straddling the boundary is still seen by the aligner. */
function overlapFromStart(segs, duration) {
  if (segs.length === 0) return [];
  const threshold = segs[0].start + duration;
  const out = [];
  for (const seg of segs) {
    if (seg.start < threshold) out.push(seg);
    else break;
  }
  return out;
}

/**
 * Sliding-window best alignment between two overlap regions.
 * `leftItems` / `rightItems` are comparable units (tokens or segments);
 * `isMatch(a, b)` decides whether a pair matches.
 * Returns { leftStart, leftEnd, rightStart, rightEnd, matches } in
 * overlap-region indices, or null when no alignment reaches MIN_MATCH_COUNT.
 */
function findBestAlignment(leftItems, rightItems, isMatch) {
  const L = leftItems.length;
  const R = rightItems.length;
  let bestScore = 0;
  let best = null;
  for (let i = 1; i <= L + R; i++) {
    const epsilon = i / 10000; // prefer longer matches on ties
    const leftStart = Math.max(0, L - i);
    const leftEnd = Math.min(L, L + R - i);
    const rightStart = Math.max(0, i - L);
    const rightEnd = Math.min(R, i);
    const leftSlice = leftItems.slice(leftStart, leftEnd);
    const rightSlice = rightItems.slice(rightStart, rightEnd);
    if (leftSlice.length !== rightSlice.length) continue;
    let matches = 0;
    for (let k = 0; k < leftSlice.length; k++) {
      if (isMatch(leftSlice[k], rightSlice[k])) matches++;
    }
    const score = matches / i + epsilon;
    if (matches >= MIN_MATCH_COUNT && score > bestScore) {
      bestScore = score;
      best = { leftStart, leftEnd, rightStart, rightEnd, matches };
    }
  }
  return best;
}

/** Merge two absolute-time segment sequences across one overlap boundary. */
function mergeTwo(left, right, overlapSec) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const leftOverlap = overlapFromEnd(left, overlapSec);
  const rightOverlap = overlapFromStart(right, overlapSec);
  if (leftOverlap.length === 0 || rightOverlap.length === 0) return left.concat(right);

  const wordLevel =
    leftOverlap.some((s) => Array.isArray(s.words) && s.words.length > 0) ||
    rightOverlap.some((s) => Array.isArray(s.words) && s.words.length > 0);

  if (wordLevel) {
    // Flatten overlap words to tokens, keeping the owning segment index.
    const leftTokens = [];
    leftOverlap.forEach((seg, si) => {
      for (const w of seg.words || []) {
        const tok = normalizeToken(w.text);
        if (tok) leftTokens.push({ tok, seg: si });
      }
    });
    const rightTokens = [];
    rightOverlap.forEach((seg, si) => {
      for (const w of seg.words || []) {
        const tok = normalizeToken(w.text);
        if (tok) rightTokens.push({ tok, seg: si });
      }
    });
    const best = findBestAlignment(
      leftTokens.map((t) => t.tok),
      rightTokens.map((t) => t.tok),
      (a, b) => a === b,
    );
    if (best) {
      const leftMidTok = Math.floor((best.leftStart + best.leftEnd - 1) / 2);
      const rightMidTok = Math.floor((best.rightStart + best.rightEnd - 1) / 2);
      const leftMidSeg = leftTokens[leftMidTok].seg;
      const rightMidSeg = rightTokens[rightMidTok].seg;
      // Left keeps segments before the midpoint segment; right starts at it.
      const leftCut = left.length - leftOverlap.length + leftMidSeg;
      const rightCut = rightMidSeg;
      return left.slice(0, leftCut).concat(right.slice(rightCut));
    }
    // else fall through to the time-boundary fallback below
  } else {
    const best = findBestAlignment(
      leftOverlap,
      rightOverlap,
      (a, b) => similarity(a.text, b.text) > FUZZY_THRESHOLD,
    );
    if (best) {
      const leftMid = Math.floor((best.leftStart + best.leftEnd - 1) / 2);
      const rightMid = Math.floor((best.rightStart + best.rightEnd - 1) / 2);
      const leftCut = left.length - leftOverlap.length + leftMid;
      return left.slice(0, leftCut).concat(right.slice(rightMid));
    }
    // else fall through to the time-boundary fallback below
  }

  // Fallback: time-boundary split — keep left segments ending before the
  // first right segment starts; if none qualify, keep all of left.
  let splitIdx = left.length;
  const rightStart = right[0].start;
  for (let i = left.length - 1; i >= 0; i--) {
    if (left[i].end <= rightStart) {
      splitIdx = i + 1;
      break;
    }
  }
  return left.slice(0, splitIdx).concat(right);
}

/**
 * Merge chunk results into one absolute-time segment list.
 * @param {Array<{offset:number, segments:Array}>} chunks chunk-relative segments
 * @param {number} overlapSec expected overlap between consecutive chunks
 * @returns {Array} merged segments in absolute seconds
 */
export function mergeChunks(chunks, overlapSec) {
  const nonEmpty = (chunks || []).filter((c) => c && Array.isArray(c.segments) && c.segments.length > 0);
  if (nonEmpty.length === 0) return [];
  const sorted = [...nonEmpty].sort((a, b) => a.offset - b.offset);
  let merged = offsetSegments(sorted[0].segments, sorted[0].offset);
  for (let i = 1; i < sorted.length; i++) {
    const right = offsetSegments(sorted[i].segments, sorted[i].offset);
    merged = mergeTwo(merged, right, overlapSec);
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  return merged;
}
