"""SRT parse/format helpers (mirrors the manager's srt.js semantics)."""


def format_timestamp(sec: float) -> str:
    if sec < 0 or sec != sec or sec in (float("inf"), float("-inf")):
        raise ValueError(f"invalid time: {sec}")
    total_ms = round(sec * 1000)
    ms = total_ms % 1000
    total_sec = total_ms // 1000
    s = total_sec % 60
    total_min = total_sec // 60
    m = total_min % 60
    h = total_min // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_timestamp(text: str) -> float:
    text = text.strip().replace(".", ",")
    try:
        hms, ms = text.split(",")
        h, m, s = hms.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
    except ValueError as e:
        raise ValueError(f"invalid SRT timestamp: {text}") from e


def format_srt(segments) -> str:
    """segments: iterable of {text, start, end} (text may contain newlines)."""
    out = []
    for i, seg in enumerate(segments, 1):
        out.append(f"{i}\n{format_timestamp(seg['start'])} --> {format_timestamp(seg['end'])}\n{seg['text']}\n")
    return "\n".join(out)


def parse_srt(text: str):
    """Parse SRT text into [{start, end, text}]. Raises ValueError on malformed blocks."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks = [b for b in normalized.split("\n\n") if b.strip()]
    segments = []
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        idx = 1 if lines[0].strip().isdigit() else 0
        if len(lines) <= idx:
            raise ValueError(f"SRT block missing time line: {block!r}")
        if "-->" not in lines[idx]:
            raise ValueError(f"SRT block missing --> line: {block!r}")
        start_s, end_s = [p.strip() for p in lines[idx].split("-->", 1)]
        text_lines = lines[idx + 1:]
        if not text_lines:
            raise ValueError(f"SRT block missing text: {block!r}")
        segments.append({
            "start": parse_timestamp(start_s),
            "end": parse_timestamp(end_s),
            "text": "\n".join(text_lines),
        })
    return segments
