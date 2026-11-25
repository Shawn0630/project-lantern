"""Transcription core: engine dispatch + segment-shape mapping.

The real WhisperJAV stack (torch + stable-ts + faster-whisper @ pinned
commit) cannot install in this environment (Python 3.12; WhisperJAV
needs >=3.13), so the whisperjav backend is tested with a fake
StableTSASR module injected into sys.modules. The real-stack word
timestamp behaviour is verified separately by the runtime check in
~/workspace/whisperjav-verify/ (JFK fixture, tiny model).
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import transcribe_core  # noqa: E402
from transcribe_core import (  # noqa: E402
    DEFAULT_ENGINE,
    ENGINES,
    is_engine_available,
    transcribe_file,
    transcribe_faster_whisper,
    transcribe_whisperjav,
    _map_stable_ts_segment,
)


# ---- dispatch ----
def test_default_engine_is_faster_whisper():
    assert DEFAULT_ENGINE == "faster-whisper"
    assert set(ENGINES) == {"faster-whisper", "whisperjav"}


def test_dispatch_calls_the_right_backend(monkeypatch):
    calls = []
    monkeypatch.setattr(transcribe_core, "transcribe_faster_whisper",
                        lambda p, m, l: calls.append(("faster-whisper", p, m, l)) or [])
    monkeypatch.setattr(transcribe_core, "transcribe_whisperjav",
                        lambda p, m, l: calls.append(("whisperjav", p, m, l)) or [])
    assert transcribe_file("/tmp/a.wav", "large-v3", "en") == []
    assert transcribe_file("/tmp/a.wav", "tiny", None, engine="whisperjav") == []
    assert calls == [
        ("faster-whisper", "/tmp/a.wav", "large-v3", "en"),
        ("whisperjav", "/tmp/a.wav", "tiny", None),
    ]


def test_unknown_engine_raises():
    with pytest.raises(ValueError, match="unknown transcription engine: nope"):
        transcribe_file("/tmp/a.wav", "large-v3", "en", engine="nope")


# ---- faster-whisper backend (fake model) ----
class _FakeWord:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class _FakeSegment:
    def __init__(self, text, start, end, words):
        self.text, self.start, self.end, self.words = text, start, end, words


class _FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, language=None, word_timestamps=False, beam_size=5):
        self.calls.append({"language": language, "word_timestamps": word_timestamps,
                           "beam_size": beam_size})
        segs = [_FakeSegment(" Hello world ", 0.0, 1.5,
                             [_FakeWord(" Hello", 0.0, 0.5), _FakeWord(" world", 0.5, 1.5)])]
        return segs, SimpleNamespace()


def test_faster_whisper_backend_shape(monkeypatch):
    model = _FakeModel()
    monkeypatch.setattr(transcribe_core, "get_faster_whisper_model", lambda name: model)
    monkeypatch.setattr(transcribe_core, "decode_audio_ffmpeg", lambda path: b"fake-audio")
    out = transcribe_faster_whisper("/tmp/a.wav", "tiny", "en")
    assert out == [{
        "text": "Hello world", "start": 0.0, "end": 1.5,
        "words": [
            {"text": "Hello", "start": 0.0, "end": 0.5},
            {"text": "world", "start": 0.5, "end": 1.5},
        ],
    }]
    # Word timestamps on, language passed through.
    assert model.calls == [{"language": "en", "word_timestamps": True, "beam_size": 5}]


# ---- whisperjav backend (fake StableTSASR) ----
class _FakeStableTSASR:
    instances = []

    def __init__(self, model_config=None, params=None, task=None, turbo_mode=False):
        self.model_config = model_config
        self.params = params
        self.task = task
        self.turbo_mode = turbo_mode
        _FakeStableTSASR.instances.append(self)

    def transcribe(self, path):
        word = SimpleNamespace(word=" Hello", start=0.1, end=0.6)
        seg = SimpleNamespace(text=" Hello ", start=0.0, end=1.0, words=[word])
        return SimpleNamespace(segments=[seg])


@pytest.fixture
def fake_whisperjav(monkeypatch):
    """Inject a fake whisperjav package; clears the core's caches first."""
    import types

    # The import system resolves parent packages first, so they must be
    # injected alongside the submodule.
    pkg = types.ModuleType("whisperjav")
    pkg.__path__ = []
    sub = types.ModuleType("whisperjav.modules")
    sub.__path__ = []
    mod = types.ModuleType("whisperjav.modules.stable_ts_asr")
    mod.StableTSASR = _FakeStableTSASR
    pkg.modules = sub
    sub.stable_ts_asr = mod
    monkeypatch.setitem(sys.modules, "whisperjav", pkg)
    monkeypatch.setitem(sys.modules, "whisperjav.modules", sub)
    monkeypatch.setitem(sys.modules, "whisperjav.modules.stable_ts_asr", mod)
    monkeypatch.setattr(transcribe_core, "_whisperjav_cache", {})
    monkeypatch.setattr(transcribe_core, "_whisperjav_available", None)
    _FakeStableTSASR.instances.clear()
    return _FakeStableTSASR


def test_whisperjav_backend_shape_and_resident_model(fake_whisperjav):
    out = transcribe_whisperjav("/tmp/a.wav", "tiny", "en")
    assert out == [{
        "text": "Hello", "start": 0.0, "end": 1.0,
        "words": [{"text": "Hello", "start": 0.1, "end": 0.6}],
    }]
    # Turbo (faster-whisper) mode, CPU int8, language passed through.
    inst = fake_whisperjav.instances[0]
    assert inst.turbo_mode is True
    assert inst.task == "transcribe"
    assert inst.model_config["model_name"] == "tiny"
    assert inst.model_config["device"] == "cpu"
    assert inst.model_config["compute_type"] == "int8"
    assert inst.params["decoder"]["language"] == "en"
    # Second call reuses the resident instance (no reload).
    transcribe_whisperjav("/tmp/b.wav", "tiny", "en")
    assert len(fake_whisperjav.instances) == 1


def test_whisperjav_large_v3_turbo_pins_mobiuslabsgmbh_repo(fake_whisperjav):
    transcribe_whisperjav("/tmp/a.wav", "large-v3-turbo", "en")
    assert fake_whisperjav.instances[0].model_config["hf_repo"] == \
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo"


def test_whisperjav_language_none_means_auto_detect(fake_whisperjav):
    transcribe_whisperjav("/tmp/a.wav", "tiny", None)
    assert fake_whisperjav.instances[0].params["decoder"]["language"] is None


def test_map_stable_ts_segment_accepts_dict_words():
    seg = SimpleNamespace(text=" hi ", start=0.0, end=2.0,
                          words=[{"word": " hi", "start": 0.0, "end": 1.0}])
    assert _map_stable_ts_segment(seg) == {
        "text": "hi", "start": 0.0, "end": 2.0,
        "words": [{"text": "hi", "start": 0.0, "end": 1.0}],
    }


def test_map_stable_ts_segment_tolerates_missing_words():
    seg = SimpleNamespace(text=" hi ", start=0.0, end=2.0, words=None)
    assert _map_stable_ts_segment(seg)["words"] == []


def test_is_engine_available_reports_whisperjav(monkeypatch, fake_whisperjav):
    assert is_engine_available("faster-whisper") is True
    assert is_engine_available("whisperjav") is True
    assert is_engine_available("nope") is False


def test_is_engine_available_false_when_import_fails(monkeypatch):
    monkeypatch.setattr(transcribe_core, "_whisperjav_available", None)
    import builtins

    real_import = builtins.__import__

    def boom(name, *args, **kwargs):
        if name.startswith("whisperjav"):
            raise ImportError("no whisperjav here")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", boom)
    assert is_engine_available("whisperjav") is False
