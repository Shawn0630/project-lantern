// SRT parse/format and SRT -> ASS conversion (burn-in subtitles).
// Segment shape: { text, start, end } with times in seconds (float).
// Text may contain "\n" for multi-line (e.g. bilingual) entries.

export function formatTime(sec) {
  if (!(sec >= 0) || !Number.isFinite(sec)) throw new Error('invalid time: ' + sec);
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function parseTime(str) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(str.trim());
  if (!m) throw new Error('invalid SRT timestamp: ' + str);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Serialize segments to SRT text. */
export function toSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`)
    .join('\n');
}

/** Parse SRT text into segments. Throws on malformed blocks. */
export function parseSrt(text) {
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    // First line is the index when numeric; otherwise the block starts at the time line.
    let timeIdx = 0;
    if (/^\d+$/.test(lines[0].trim())) timeIdx = 1;
    if (lines.length <= timeIdx) throw new Error('SRT block missing time line: ' + block);
    const m = /^(.+?)\s*-->\s*(.+)$/.exec(lines[timeIdx].trim());
    if (!m) throw new Error('SRT block missing --> line: ' + block);
    const textLines = lines.slice(timeIdx + 1);
    if (textLines.length === 0) throw new Error('SRT block missing text: ' + block);
    segments.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: textLines.join('\n') });
  }
  return segments;
}

function assTime(sec) {
  const totalCs = Math.round(sec * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAss(text) {
  return text.replace(/\{/g, '').replace(/\}/g, '').replace(/\n/g, '\\N');
}

/**
 * Convert segments to ASS (Advanced Substation Alpha) for ffmpeg burn-in.
 * Simple clean style: white text, black outline, bottom center.
 * @param {Array} segments {text, start, end}; text may contain "\n" for a second line.
 * @param {Object} [opts] { fontSize, fontName, marginV }
 */
export function toAss(segments, opts = {}) {
  const fontSize = opts.fontSize ?? 22;
  const fontName = opts.fontName ?? 'sans-serif';
  const marginV = opts.marginV ?? 28;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = segments
    .map((seg) => `Dialogue: 0,${assTime(seg.start)},${assTime(seg.end)},Default,,0,0,0,,${escapeAss(seg.text)}`)
    .join('\n');
  return header + events + '\n';
}
