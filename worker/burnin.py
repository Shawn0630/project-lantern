"""Worker-side segmented burn-in: burn ASS subtitles into a video segment.

The manager dictates the encode parameters (libx264, CRF 20) and the source
video properties (resolution, fps). The worker never changes resolution or
frame rate — the manager concatenates the segments with the ffmpeg concat
demuxer, which requires identical parameters across segments. Both the input
segment and the encoded output are probed and checked against the manager's
stated properties before the result is reported.
"""
import json
import subprocess

CRF_DEFAULT = 20


def escape_filter_path(p):
    """Escape a path for ffmpeg's subtitles filter (escape backslash, :, ')."""
    return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def probe_video(path):
    """ffprobe a file; return {codec, width, height, fps, audio_bitrate}.

    audio_bitrate is in bits/s, or None when the file has no audio stream.
    """
    proc = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(proc.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise RuntimeError(f"no video stream in {path}")
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    num, den = (video.get("avg_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    bitrate = audio.get("bit_rate") if audio else None
    return {
        "codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "fps": fps,
        "has_audio": audio is not None,
        "audio_bitrate": int(bitrate) if bitrate else None,
    }


def check_matches(actual, expected, what):
    """Assert a probed video matches the manager's stated properties.

    `expected` uses the manager's keys (videoCodec/fps/width/height); None
    values are skipped. fps is compared with a small tolerance.
    """
    for key, field in (("videoCodec", "codec"), ("width", "width"), ("height", "height")):
        want = expected.get(key)
        if want is not None and actual.get(field) != want:
            raise RuntimeError(f"{what} has {field} {actual.get(field)}, expected {want}")
    want_fps = expected.get("fps")
    if want_fps is not None and actual.get("fps") is not None and abs(actual["fps"] - want_fps) > 0.01:
        raise RuntimeError(f"{what} has fps {actual['fps']}, expected {want_fps}")


def build_burnin_cmd(segment_path, ass_path, out_path, trim_start, duration, crf=CRF_DEFAULT, audio_bitrate=None, has_audio=True):
    """Build the ffmpeg burn-in command.

    -ss before -i trims the keyframe-overshoot the manager's stream-copy cut
    left at the head of the segment; the re-encode makes the trim
    frame-accurate. -t limits the output to the segment duration. Audio is
    re-encoded to AAC (never stream-copied, because the trim needs
    frame-accurate audio); when the segment has no audio stream, -an is used.
    No resolution or frame-rate flags: the output keeps the input's.
    """
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(trim_start),
        "-i", segment_path,
        "-vf", f"subtitles='{escape_filter_path(ass_path)}'",
        "-c:v", "libx264", "-crf", str(crf),
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", str(audio_bitrate or 128000)]
    else:
        cmd += ["-an"]
    cmd += ["-t", str(duration), out_path]
    return cmd


def burnin_segment(segment_path, ass_path, out_path, payload):
    """Burn one segment. `payload` is the manager's burnin task payload.

    Probes the input segment and the encoded output against the payload's
    stated properties; raises on any mismatch. Returns the output path.
    """
    expected = {
        "videoCodec": payload.get("videoCodec"),
        "fps": payload.get("fps"),
        "width": payload.get("width"),
        "height": payload.get("height"),
    }
    info = probe_video(segment_path)
    check_matches(info, expected, "burn-in input segment")
    cmd = build_burnin_cmd(
        segment_path,
        ass_path,
        out_path,
        payload.get("trimStart", 0),
        payload.get("duration"),
        crf=payload.get("crf", CRF_DEFAULT),
        audio_bitrate=payload.get("audioBitrate") or info.get("audio_bitrate"),
        has_audio=info.get("has_audio", True),
    )
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    out_info = probe_video(out_path)
    check_matches(out_info, expected, "burned segment")
    return out_path
