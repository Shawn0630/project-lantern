"""Worker unit tests: SRT helpers + Gemini response parsing (mocked HTTP)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from srt_utils import format_timestamp, parse_timestamp, format_srt, parse_srt  # noqa: E402
from gemini import build_translate_prompt, parse_numbered_lines, translate_lines  # noqa: E402


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


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
