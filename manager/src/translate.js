// Translate-stage helpers: group merged segments into per-task batches
// and verify worker results preserve the segment count exactly.

export const DEFAULT_GROUP_SIZE = 20;

/** Split segments into groups of at most `size` (keeps original indices). */
export function groupSegments(segments, size = DEFAULT_GROUP_SIZE) {
  const groups = [];
  for (let i = 0; i < segments.length; i += size) {
    groups.push({
      groupIndex: groups.length,
      segments: segments.slice(i, i + size).map((seg, k) => ({
        index: i + k,
        text: seg.text,
        start: seg.start,
        end: seg.end,
      })),
    });
  }
  return groups;
}

/**
 * Verify a worker's translate result for one group.
 * @param {Object} group the group sent to the worker
 * @param {Array<string>} lines translated lines returned by the worker
 * @returns {{ ok: boolean, error?: string }}
 */
export function verifyTranslateResult(group, lines) {
  if (!Array.isArray(lines)) return { ok: false, error: 'result is not an array' };
  if (lines.length !== group.segments.length) {
    return {
      ok: false,
      error: `line count mismatch: expected ${group.segments.length}, got ${lines.length}`,
    };
  }
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim() === '') {
      return { ok: false, error: 'empty translated line' };
    }
  }
  return { ok: true };
}
