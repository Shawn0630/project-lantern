"""Worker burn-in tests: ffmpeg command construction + probe parsing (mocked)."""
import json
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import burnin  # noqa: E402


def test_escape_filter_path():
    assert burnin.escape_filter_path("/tmp/a'b:c.ass") == "/tmp/a\\'b\\:c.ass"
    assert burnin.escape_filter_path("/tmp/a\\b.ass") == "/tmp/a\\\\b.ass"


def test_build_burnin_cmd_flags():
    cmd = burnin.build_burnin_cmd("seg.mp4", "a.ass", "out.mp4", 1.2, 29.05)
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-ss") + 1] == "1.2"
    assert cmd.index("-ss") < cmd.index("-i")  # input seek: trim before decode
    assert cmd[cmd.index("-t") + 1] == "29.05"
    assert "-c:v" in cmd and "libx264" in cmd
    assert "-pix_fmt" in cmd and cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-crf") + 1] == "20"
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("subtitles='") and "a.ass" in vf
    assert "-c:a" in cmd and "aac" in cmd
    assert cmd[cmd.index("-b:a") + 1] == "128000"
    assert cmd[-1] == "out.mp4"
    # Never changes resolution or frame rate.
    assert "-s" not in cmd and "-r" not in cmd and "-vf" in cmd
    assert "-c:a" not in cmd or "copy" not in cmd[cmd.index("-c:a"):cmd.index("-c:a") + 2]


def test_build_burnin_cmd_no_audio_uses_an():
    cmd = burnin.build_burnin_cmd("seg.mp4", "a.ass", "out.mp4", 0, 10, has_audio=False)
    assert "-an" in cmd
    assert "-c:a" not in cmd
    assert "-b:a" not in cmd


def test_build_burnin_cmd_uses_source_audio_bitrate():
    cmd = burnin.build_burnin_cmd("seg.mp4", "a.ass", "out.mp4", 0, 10, audio_bitrate=192000)
    assert cmd[cmd.index("-b:a") + 1] == "192000"


def _ffprobe_json(fps="30000/1001", bitrate="128000"):
    return json.dumps({"streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "avg_frame_rate": fps},
        {"codec_type": "audio", "codec_name": "aac", "bit_rate": bitrate},
    ]})


def test_probe_video_parses_ffprobe():
    fake = mock.Mock()
    fake.stdout = _ffprobe_json()
    with mock.patch.object(burnin.subprocess, "run", return_value=fake) as run:
        info = burnin.probe_video("x.mp4")
    assert info["codec"] == "h264"
    assert info["width"] == 640 and info["height"] == 360
    assert abs(info["fps"] - 29.970) < 0.001
    assert info["audio_bitrate"] == 128000
    assert info["has_audio"] is True
    assert run.call_args[0][0][0] == "ffprobe"


def test_probe_video_no_audio_stream():
    fake = mock.Mock()
    fake.stdout = json.dumps({"streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "avg_frame_rate": "30/1"},
    ]})
    with mock.patch.object(burnin.subprocess, "run", return_value=fake):
        info = burnin.probe_video("x.mp4")
    assert info["has_audio"] is False
    assert info["audio_bitrate"] is None


def test_probe_video_rejects_no_video_stream():
    fake = mock.Mock()
    fake.stdout = json.dumps({"streams": [
        {"codec_type": "audio", "codec_name": "aac", "bit_rate": "128000"},
    ]})
    with mock.patch.object(burnin.subprocess, "run", return_value=fake):
        with pytest.raises(RuntimeError, match="no video stream"):
            burnin.probe_video("x.mp4")


def test_check_matches():
    actual = {"codec": "h264", "width": 640, "height": 360, "fps": 30.0}
    expected = {"videoCodec": "h264", "width": 640, "height": 360, "fps": 30.0}
    burnin.check_matches(actual, expected, "x")
    # fps within tolerance passes.
    burnin.check_matches({**actual, "fps": 30.005}, expected, "x")
    # None expected values are skipped.
    burnin.check_matches(actual, {"videoCodec": None, "width": None, "height": None, "fps": None}, "x")
    with pytest.raises(RuntimeError, match="width 320"):
        burnin.check_matches({**actual, "width": 320}, expected, "x")
    with pytest.raises(RuntimeError, match="fps 25"):
        burnin.check_matches({**actual, "fps": 25.0}, expected, "x")


def _fake_run_factory(output_fps="30/1"):
    """Fake subprocess.run: ffprobe returns canned JSON, ffmpeg records the call."""
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        m = mock.Mock()
        if cmd[0] == "ffprobe":
            # First ffprobe call probes the input, the second the output.
            probe_no = len([c for c in calls if c[0] == "ffprobe"])
            fps = "30/1" if probe_no == 1 else output_fps
            m.stdout = _ffprobe_json(fps=fps)
        return m

    return fake_run, calls


PAYLOAD = {
    "trimStart": 1.0, "duration": 10, "crf": 20,
    "fps": 30, "width": 640, "height": 360,
    "videoCodec": "h264", "audioBitrate": 128000,
}


def test_burnin_segment_flow_mocked():
    fake_run, calls = _fake_run_factory()
    with mock.patch.object(burnin.subprocess, "run", side_effect=fake_run):
        out = burnin.burnin_segment("seg.mp4", "a.ass", "out.mp4", PAYLOAD)
    assert out == "out.mp4"
    ffmpeg_calls = [c for c in calls if c[0] == "ffmpeg"]
    assert len(ffmpeg_calls) == 1
    assert "-ss" in ffmpeg_calls[0] and "libx264" in ffmpeg_calls[0]
    assert ffmpeg_calls[0][ffmpeg_calls[0].index("-t") + 1] == "10"
    assert len([c for c in calls if c[0] == "ffprobe"]) == 2  # input + output


def test_burnin_segment_output_mismatch_raises():
    fake_run, _calls = _fake_run_factory(output_fps="25/1")
    with mock.patch.object(burnin.subprocess, "run", side_effect=fake_run):
        with pytest.raises(RuntimeError, match="fps 25"):
            burnin.burnin_segment("seg.mp4", "a.ass", "out.mp4", PAYLOAD)


def test_burnin_segment_input_mismatch_raises():
    def fake_run(cmd, **kw):
        m = mock.Mock()
        if cmd[0] == "ffprobe":
            m.stdout = json.dumps({"streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 320, "height": 360, "avg_frame_rate": "30/1"},
                {"codec_type": "audio", "codec_name": "aac", "bit_rate": "128000"},
            ]})
        return m

    with mock.patch.object(burnin.subprocess, "run", side_effect=fake_run):
        with pytest.raises(RuntimeError, match="width 320"):
            burnin.burnin_segment("seg.mp4", "a.ass", "out.mp4", PAYLOAD)
