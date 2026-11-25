"""Worker unit tests: SRT helpers + Gemini response parsing (mocked HTTP)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from srt_utils import format_timestamp, parse_timestamp, format_srt, parse_srt  # noqa: E402
from gemini import build_translate_prompt, parse_numbered_lines, translate_lines  # noqa: E402


class FakeResponse:
    def __init__(self, status_code, payload=None, text="", content=b""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self._content = content

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=1 << 20):
        for i in range(0, len(self._content), chunk_size):
            yield self._content[i:i + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    """Records posts and returns canned responses in order."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, params=None, json=None, timeout=None):
        self.calls.append({"url": url, "params": params, "json": json})
        if not self.responses:
            raise AssertionError("no more canned responses")
        resp = self.responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def gemini_ok(text):
    return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


# ---- SRT ----
def test_timestamp_round_trip():
    assert format_timestamp(0) == "00:00:00,000"
    assert format_timestamp(61.5) == "00:01:01,500"
    assert format_timestamp(3661.234) == "01:01:01,234"
    assert parse_timestamp("00:01:01,500") == 61.5
    assert parse_timestamp(format_timestamp(123.456)) == 123.456
    with pytest.raises(ValueError):
        format_timestamp(-1)
    with pytest.raises(ValueError):
        parse_timestamp("nope")


def test_srt_round_trip():
    segs = [
        {"text": "Hello world", "start": 0.5, "end": 2.25},
        {"text": "Second line\nwith a break", "start": 3, "end": 5.5},
        {"text": "你好世界", "start": 3661.234, "end": 3663},
    ]
    assert parse_srt(format_srt(segs)) == segs


def test_srt_parse_tolerates_crlf_and_missing_index():
    parsed = parse_srt("00:00:01,000 --> 00:00:02,000\r\nHi there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n")
    assert len(parsed) == 2
    assert parsed[0]["text"] == "Hi there"
    assert parsed[1]["text"] == "Bye"


def test_srt_parse_rejects_malformed():
    with pytest.raises(ValueError):
        parse_srt("1\nno time line here\nHello\n")
    with pytest.raises(ValueError):
        parse_srt("1\n00:00:01,000 --> 00:00:02,000\n")


# ---- Gemini prompt / parsing ----
def test_build_translate_prompt_numbers_lines():
    prompt = build_translate_prompt(["Hello", "How are you?"], "en", "zh-CN")
    assert "1. Hello" in prompt
    assert "2. How are you?" in prompt
    assert "EXACTLY the same number of lines" in prompt


def test_parse_numbered_lines_ok():
    assert parse_numbered_lines("1. 你好世界\n2. 你好吗？", 2) == ["你好世界", "你好吗？"]
    assert parse_numbered_lines("\n1) 第一行\n\n2) 第二行\n", 2) == ["第一行", "第二行"]
    # Unnumbered fallback: plain lines in order.
    assert parse_numbered_lines("第一行\n第二行", 2) == ["第一行", "第二行"]


def test_parse_numbered_lines_mismatch():
    with pytest.raises(ValueError, match="line count mismatch"):
        parse_numbered_lines("1. only one", 2)
    with pytest.raises(ValueError, match="line count mismatch"):
        parse_numbered_lines("1. a\n2. b\n3. c", 2)


def test_translate_lines_success_with_mock():
    session = FakeSession([gemini_ok("1. 你好\n2. 世界")])
    out = translate_lines(["Hello", "world"], "en", "zh-CN", "key", "gemini-2.5-flash", session=session, sleep=lambda s: None)
    assert out == ["你好", "世界"]
    assert len(session.calls) == 1
    assert session.calls[0]["params"] == {"key": "key"}
    assert "gemini-2.5-flash" in session.calls[0]["url"]


def test_translate_lines_retries_transient_then_succeeds():
    session = FakeSession([
        FakeResponse(503, text="overloaded"),
        FakeResponse(429, text="rate limited"),
        gemini_ok("1. 你好"),
    ])
    sleeps = []
    out = translate_lines(["Hello"], "en", "zh-CN", "key", "m", session=session, sleep=sleeps.append)
    assert out == ["你好"]
    assert len(session.calls) == 3
    assert sleeps == [2, 4]


def test_translate_lines_gives_up_after_retries():
    session = FakeSession([FakeResponse(503, text="x")] * 3)
    with pytest.raises(RuntimeError, match="Gemini HTTP 503"):
        translate_lines(["Hello"], "en", "zh-CN", "key", "m", session=session, sleep=lambda s: None)
    assert len(session.calls) == 3


def test_translate_lines_count_mismatch_retries_then_raises():
    session = FakeSession([gemini_ok("1. only one")] * 3)
    with pytest.raises(ValueError, match="line count mismatch"):
        translate_lines(["a", "b"], "en", "zh-CN", "key", "m", session=session, sleep=lambda s: None)
    assert len(session.calls) == 3


def test_translate_lines_requires_key():
    with pytest.raises(RuntimeError, match="no LLM API key"):
        translate_lines(["a"], "en", "zh-CN", "", "m", session=FakeSession([]))


# ---- scheduler v1.2: capabilities, stats, claim ack ----
import os  # noqa: E402
import shutil  # noqa: E402

# The worker resolves its stable id at import time; pin it in tests so
# importing the module never writes to the real ~/.lantern.
os.environ.setdefault("WORKER_ID", "test-worker")

import worker as worker_mod  # noqa: E402


def test_collect_stats_shape():
    stats = worker_mod.collect_stats()
    assert set(stats) == {"loadAvg1", "cpuPercent", "memUsedMb", "memTotalMb"}
    assert stats["loadAvg1"] is None or isinstance(stats["loadAvg1"], float)
    assert stats["cpuPercent"] is None or isinstance(stats["cpuPercent"], float)


def test_collect_stats_reports_memory_when_psutil_available():
    # psutil is a real dependency (requirements.txt): it is the only stats
    # source on Windows, where /proc/meminfo does not exist.
    pytest.importorskip("psutil")
    stats = worker_mod.collect_stats()
    assert stats["memTotalMb"] is not None and stats["memTotalMb"] > 0
    assert stats["memUsedMb"] is not None and 0 <= stats["memUsedMb"] <= stats["memTotalMb"]
    assert stats["cpuPercent"] is None or isinstance(stats["cpuPercent"], float)


def test_capabilities_include_burnin_when_ffmpeg_present():
    caps = worker_mod.capabilities()
    assert "transcribe" in caps and "translate" in caps
    assert ("burnin" in caps) == (shutil.which("ffmpeg") is not None)


def test_claim_acks_task_before_returning_it(monkeypatch):
    task = {"taskId": "task_1", "type": "transcribe",
            "inputUrl": "/api/tasks/task_1/input", "inputKind": "file"}
    posted = {}

    def fake_get(url, params=None, timeout=None):
        assert params == {"type": "transcribe", "workerId": worker_mod.WORKER_ID}
        return FakeResponse(200, task)

    def fake_post(path, payload, timeout=30):
        posted["path"] = path
        posted["payload"] = payload
        return FakeResponse(200, {"ok": True})

    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    monkeypatch.setattr(worker_mod, "manager_post", fake_post)
    assert worker_mod.claim("transcribe") == task
    assert posted["path"] == "/api/tasks/task_1/ack"
    assert posted["payload"] == {"workerId": worker_mod.WORKER_ID}


def test_claim_returns_none_when_ack_rejected(monkeypatch):
    task = {"taskId": "task_1", "type": "transcribe",
            "inputUrl": "/api/tasks/task_1/input", "inputKind": "file"}

    def fake_get(url, params=None, timeout=None):
        return FakeResponse(200, task)

    def fake_post(path, payload, timeout=30):
        return FakeResponse(409, text="task is not assigned")

    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    monkeypatch.setattr(worker_mod, "manager_post", fake_post)
    assert worker_mod.claim("transcribe") is None


def test_heartbeat_reports_capabilities_and_stats(monkeypatch):
    posted = {}

    def fake_post(path, payload, timeout=30):
        posted["path"] = path
        posted["payload"] = payload
        return FakeResponse(200, {"id": "x", "registered": False})

    monkeypatch.setattr(worker_mod, "manager_post", fake_post)
    worker_mod.heartbeat()
    assert posted["path"] == "/api/workers/heartbeat"
    payload = posted["payload"]
    assert "transcribe" in payload["capabilities"]
    assert "translate" in payload["capabilities"]
    assert isinstance(payload["ffmpeg"], bool)
    assert set(payload["stats"]) == {"loadAvg1", "cpuPercent", "memUsedMb", "memTotalMb"}
    assert payload["load"] in (0, 1)
    assert payload["version"] == worker_mod.VERSION


# ---- stable worker identity (dedupe across deploys) ----
def test_resolve_worker_id_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("WORKER_ID", "explicit-id")
    assert worker_mod.resolve_worker_id() == "explicit-id"


def test_resolve_worker_id_persists_in_data_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("WORKER_ID", raising=False)
    monkeypatch.setenv("WORKER_DATA_DIR", str(tmp_path))
    first = worker_mod.resolve_worker_id()
    assert first
    assert (tmp_path / "worker-id").read_text().strip() == first
    assert worker_mod.resolve_worker_id() == first


def test_resolve_worker_id_regenerates_on_empty_file(monkeypatch, tmp_path):
    monkeypatch.delenv("WORKER_ID", raising=False)
    monkeypatch.setenv("WORKER_DATA_DIR", str(tmp_path))
    (tmp_path / "worker-id").write_text("\n")
    first = worker_mod.resolve_worker_id()
    assert first
    assert worker_mod.resolve_worker_id() == first


def test_heartbeat_sends_stable_id_and_boot_id(monkeypatch):
    posted = []

    def fake_post(path, payload, timeout=30):
        posted.append(payload)
        return FakeResponse(200, {"id": "x", "registered": False})

    monkeypatch.setattr(worker_mod, "manager_post", fake_post)
    worker_mod.heartbeat()
    worker_mod.heartbeat()
    assert len(posted) == 2
    for payload in posted:
        assert payload["id"] == worker_mod.WORKER_ID
        assert payload["bootId"] == worker_mod.BOOT_ID
    assert posted[0]["bootId"] == posted[1]["bootId"]


# ---- models report (per-worker models) ----
def _fake_hf_cache(tmp_path, repos):
    """Build a fake HF hub cache: repos = {repo_id: has_model_bin}."""
    hub = tmp_path / "hub"
    for repo_id, has_bin in repos.items():
        org, name = repo_id.split("/", 1)
        snap = hub / f"models--{org}--{name}" / "snapshots" / "abc123"
        snap.mkdir(parents=True)
        if has_bin:
            (snap / "model.bin").write_bytes(b"fake")
        else:
            (snap / "config.json").write_text("{}")
    return hub


def test_list_downloaded_models_scans_hf_cache(monkeypatch, tmp_path):
    _fake_hf_cache(tmp_path, {
        "Systran/faster-whisper-large-v3": True,
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo": True,
        "Systran/faster-whisper-small": False,  # incomplete snapshot: no model.bin
        "someone/random-model": True,  # unknown repo: not a Whisper model
    })
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    assert worker_mod.list_downloaded_models() == ["large-v3", "large-v3-turbo"]


def test_list_downloaded_models_empty_without_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    assert worker_mod.list_downloaded_models() == []


def test_list_downloaded_models_includes_loaded_models(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    import transcribe_core

    monkeypatch.setitem(transcribe_core._fw_model_cache, "tiny", object())
    assert worker_mod.list_downloaded_models() == ["tiny"]


def test_heartbeat_reports_models(monkeypatch, tmp_path):
    _fake_hf_cache(tmp_path, {"Systran/faster-whisper-large-v3": True})
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    posted = {}

    def fake_post(path, payload, timeout=30):
        posted["payload"] = payload
        return FakeResponse(200, {"id": "x", "registered": False})

    monkeypatch.setattr(worker_mod, "manager_post", fake_post)
    worker_mod.heartbeat()
    assert posted["payload"]["models"] == {"loaded": None, "available": ["large-v3"]}

# ---- repo video download (LAN video library) ----
def test_download_repo_video_full(monkeypatch, tmp_path):
    data = b"0123456789AB"
    seen = {}

    def fake_get(url, headers=None, stream=None, timeout=None):
        seen["url"] = url
        seen["headers"] = headers
        assert headers == {}
        assert stream is True
        return FakeResponse(200, content=data)

    monkeypatch.setattr(worker_mod, "MANAGER_URL", "http://manager:9400")
    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    dest = tmp_path / "clip.mp4"
    assert worker_mod.download_repo_video("video_abc", dest) == str(dest)
    assert dest.read_bytes() == data
    assert seen["url"] == "http://manager:9400/api/repo/videos/video_abc"


def test_download_repo_video_resumes_partial(monkeypatch, tmp_path):
    data = b"0123456789AB"
    seen = {}

    def fake_get(url, headers=None, stream=None, timeout=None):
        seen["headers"] = headers
        assert headers == {"Range": "bytes=4-"}
        return FakeResponse(206, content=data[4:])

    monkeypatch.setattr(worker_mod, "MANAGER_URL", "http://manager:9400")
    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    dest = tmp_path / "clip.mp4"
    dest.write_bytes(data[:4])
    assert worker_mod.download_repo_video("video_abc", dest) == str(dest)
    assert dest.read_bytes() == data


def test_download_repo_video_restarts_when_server_ignores_range(monkeypatch, tmp_path):
    data = b"0123456789AB"

    def fake_get(url, headers=None, stream=None, timeout=None):
        assert headers == {"Range": "bytes=4-"}
        return FakeResponse(200, content=data)

    monkeypatch.setattr(worker_mod, "MANAGER_URL", "http://manager:9400")
    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    dest = tmp_path / "clip.mp4"
    dest.write_bytes(data[:4])
    assert worker_mod.download_repo_video("video_abc", dest) == str(dest)
    assert dest.read_bytes() == data


def test_download_repo_video_raises_on_http_error(monkeypatch, tmp_path):
    def fake_get(url, headers=None, stream=None, timeout=None):
        return FakeResponse(404, text="repo video not found")

    monkeypatch.setattr(worker_mod, "MANAGER_URL", "http://manager:9400")
    monkeypatch.setattr(worker_mod.requests, "get", fake_get)
    with pytest.raises(RuntimeError, match="HTTP 404"):
        worker_mod.download_repo_video("video_nope", tmp_path / "clip.mp4")


def test_capabilities_include_final_burnin_when_ffmpeg_present():
    caps = worker_mod.capabilities()
    assert ("final-burnin" in caps) == (shutil.which("ffmpeg") is not None)
    # final-burnin rides the same ffmpeg capability as burnin.
    assert ("final-burnin" in caps) == ("burnin" in caps)


def test_run_final_burnin_downloads_uploads_and_cleans_up(monkeypatch, tmp_path):
    """run_final_burnin: JSON payload -> download video+ASS -> burnin_full
    (whole video) -> upload result file; temp files removed afterwards."""
    import os

    payload = {
        "taskId": "task_fb",
        "type": "final-burnin",
        "videoUrl": "/api/tasks/task_fb/input?part=video",
        "assUrl": "/api/tasks/task_fb/input?part=ass",
        "duration": 67.2,
        "crf": 20,
        "fps": 30, "width": 640, "height": 360,
        "videoCodec": "h264", "audioBitrate": 128000,
    }
    video_file = tmp_path / "clip.mp4"
    ass_file = tmp_path / "final.ass"
    video_file.write_bytes(b"fake video")
    ass_file.write_text("fake ass")
    downloads = [str(video_file), str(ass_file)]
    calls = {}

    monkeypatch.setattr(worker_mod, "download_input", lambda task: ("json", payload))
    monkeypatch.setattr(worker_mod, "download_url", lambda url, suffix: downloads.pop(0))
    def fake_burnin_full(video_path, ass_path, out_path, p):
        calls["burnin_full"] = (video_path, ass_path, out_path, p)
    monkeypatch.setattr(worker_mod.burnin, "burnin_full", fake_burnin_full)
    def fake_upload(task_id, path):
        calls["upload"] = (task_id, path)
    monkeypatch.setattr(worker_mod, "upload_result_file", fake_upload)

    worker_mod.run_final_burnin({"taskId": "task_fb", "type": "final-burnin"})

    assert calls["burnin_full"][0] == str(video_file)
    assert calls["burnin_full"][1] == str(ass_file)
    assert calls["burnin_full"][3] is payload
    assert calls["upload"][0] == "task_fb"
    assert calls["upload"][1] == calls["burnin_full"][2]
    # The downloaded inputs and the temp output are removed afterwards.
    assert not os.path.exists(str(video_file))
    assert not os.path.exists(str(ass_file))
    assert not os.path.exists(calls["upload"][1])
