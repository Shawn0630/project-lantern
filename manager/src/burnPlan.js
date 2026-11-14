// Burn-in segment planning: split a video timeline into burn segments whose
// boundaries fall in subtitle gaps, so no subtitle line ever straddles a
// segment boundary. The manager cuts the video at those boundaries; workers
// burn one segment each; the manager concatenates the results.
//
// Segment shape: { index, start, end, subtitles } — subtitles are the
// absolute-time subtitle objects belonging to that segment.

/**
 * Plan burn segments over a video timeline.
 * @param {number} durationSec total video duration in seconds (> 0)
 * @param {Array} subtitles subtitle segments {text, start, end} (absolute seconds)
 * @param {number} chunkSec target segment length in seconds (> 0)
 * @returns {{index:number, start:number, end:number, subtitles:Array}[]}
 */
export function planBurnSegments(durationSec, subtitles, chunkSec) {
  if (!(durationSec > 0)) throw new Error('durationSec must be > 0');
  if (!(chunkSec > 0)) throw new Error('chunkSec must be > 0');
  const round3 = (v) => Math.round(v * 1000) / 1000;

  const subs = (subtitles || [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(durationSec, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Safe boundary points: midpoints of gaps between consecutive subtitles,
  // or the shared point when two subtitles touch exactly. A point only
  // counts when it lies strictly inside no subtitle, so even overlapping
  // input can never produce a boundary through a line.
  const points = new Set();
  for (let i = 0; i + 1 < subs.length; i++) {
    const gapStart = subs[i].end;
    const gapEnd = subs[i + 1].start;
    if (gapEnd > gapStart) points.add(round3((gapStart + gapEnd) / 2));
    else if (gapEnd === gapStart) points.add(round3(gapStart));
    // Overlapping subtitles (gapEnd < gapStart): no safe point from this pair.
  }
  const safe = [...points]
    .filter((p) => p > 0 && p < durationSec && !subs.some((s) => s.start < p && p < s.end))
    .sort((a, b) => a - b);

  // Walk the timeline in chunkSec steps, snapping each boundary to the
  // nearest safe point. A segment is never shorter than minSeg, and a tail
  // shorter than tailEps is folded into the previous segment.
  const minSeg = Math.min(30, chunkSec / 2);
  const tailEps = Math.max(2, chunkSec * 0.1);
  const ranges = [];
  let start = 0;
  while (start < durationSec) {
    const target = start + chunkSec;
    if (target >= durationSec - tailEps) {
      ranges.push({ start: round3(start), end: round3(durationSec) });
      break;
    }
    const candidates = safe.filter((p) => p > start + minSeg && p < durationSec);
    if (candidates.length === 0) {
      ranges.push({ start: round3(start), end: round3(durationSec) });
      break;
    }
    let best = candidates[0];
    let bestDist = Math.abs(candidates[0] - target);
    for (const p of candidates) {
      const d = Math.abs(p - target);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    ranges.push({ start: round3(start), end: round3(best) });
    start = best;
  }

  // Assign each subtitle to the segment containing its start. Boundaries
  // never fall inside a subtitle, so the whole [start, end] lies in that
  // segment and no line appears in two segments.
  const out = ranges.map((r, index) => ({ index, start: r.start, end: r.end, subtitles: [] }));
  for (const s of subs) {
    let idx = out.findIndex((r) => s.start >= r.start && s.start < r.end);
    if (idx === -1) idx = out.length - 1;
    out[idx].subtitles.push(s);
  }
  return out;
}

/** Shift subtitle times by an offset (ms precision, clamped at 0). */
export function shiftSegments(segments, offset) {
  const round3 = (v) => Math.round(v * 1000) / 1000;
  return (segments || []).map((s) => ({
    text: s.text,
    start: Math.max(0, round3(s.start + offset)),
    end: Math.max(0, round3(s.end + offset)),
  }));
}
