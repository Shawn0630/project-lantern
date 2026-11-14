// Chunk planning for long audio: fixed-length windows with overlap.
// Original implementation guided by the standard approach used by
// chunked-ASR tools (10-minute windows, 10-second overlap): each next
// window starts (chunkSec - overlapSec) after the previous one.

/**
 * Plan overlapping chunks over an audio track.
 * @param {number} durationSec total audio duration in seconds (> 0)
 * @param {number} chunkSec window length in seconds (> 0)
 * @param {number} overlapSec overlap between consecutive windows (>= 0, < chunkSec)
 * @returns {{index:number, start:number, end:number}[]} chunks, times in seconds (ms precision)
 */
export function planChunks(durationSec, chunkSec, overlapSec) {
  if (!(durationSec > 0)) throw new Error('durationSec must be > 0');
  if (!(chunkSec > 0)) throw new Error('chunkSec must be > 0');
  if (!(overlapSec >= 0)) throw new Error('overlapSec must be >= 0');
  if (overlapSec >= chunkSec) throw new Error('overlapSec must be < chunkSec');

  const round3 = (v) => Math.round(v * 1000) / 1000;
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < durationSec) {
    const end = Math.min(start + chunkSec, durationSec);
    chunks.push({ index, start: round3(start), end: round3(end) });
    index += 1;
    if (end >= durationSec) break;
    start += chunkSec - overlapSec;
  }
  return chunks;
}
