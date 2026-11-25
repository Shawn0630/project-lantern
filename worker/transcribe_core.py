"""Shared transcription core for the Lantern worker.

One interface, two engines — input (audio file, model, language, engine)
goes in, Lantern's segment shape comes out:

    {"text": str, "start": float, "end": float,
     "words": [{"text": str, "start": float, "end": float}]}

Engines:
  faster-whisper — the original engine. Plain faster-whisper with CPU
      int8, word timestamps on. This is the default; existing behaviour
      is unchanged when the job does not pick another engine.
  whisperjav — WhisperJAV's stable-ts ASR module (StableTSASR, turbo /
      faster-whisper backend). It returns a stable-whisper WhisperResult
      whose segments carry word-level timestamps natively, which is what
      Lantern's chunk merge and resegmentation need.

Why StableTSASR and not WhisperJAV's default "balanced" pipeline:
  the balanced pipeline (FasterWhisperProASR) never asks faster-whisper
  for word timestamps — `word_timestamps` appears nowhere in that module
  and every segment it builds is {start, end, text, avg_logprob} — and
  its SRT output has no word times either. Shipping it would silently
  drop Lantern to fuzzy sentence-level merging. StableTSASR is the
  WhisperJAV module that does yield word timestamps, so it is the one
  this backend uses. (Its Japanese dialogue post-processor still runs
  inside transcribe(); it works from the word list, so words survive,
  and Lantern's resegment step rebuilds segment boundaries from words
  anyway.)

The whisperjav import is lazy: workers without WhisperJAV installed
(old images) can still run the faster-whisper engine, and --help/health
work without the model stack. `is_engine_available` reports what this
worker can actually run.
"""
import logging
import subprocess

log = logging.getLogger("lantern-worker")

ENGINES = ("faster-whisper", "whisperjav")
DEFAULT_ENGINE = "faster-whisper"

# faster-whisper models are loaded through faster-whisper's own registry,
# except large-v3-turbo, which lives under mobiuslabsgmbh (WhisperJAV's
# repo derivation would wrongly guess Systran/faster-whisper-large-v3-turbo
# for the prefetch — the load itself would still work, but the prefetch
# would fail loudly, so pin the repo here).
_FASTER_WHISPER_REPOS = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

# ---- faster-whisper backend (moved from worker.py, behaviour unchanged) ----
_fw_model_cache = {}
# Last faster-whisper model loaded (for the heartbeat "loaded" field).
loaded_faster_whisper_model = None


def get_faster_whisper_model(model_name: str):
    global loaded_faster_whisper_model
    if model_name not in _fw_model_cache:
        from faster_whisper import WhisperModel

        log.info("Loading faster-whisper model %s (CPU, int8)", model_name)
        _fw_model_cache[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
        loaded_faster_whisper_model = model_name
    return _fw_model_cache[model_name]


def loaded_faster_whisper_models():
    """Names of faster-whisper models loaded in this process."""
    return set(_fw_model_cache)


def decode_audio_ffmpeg(path: str):
    """Decode audio to 16 kHz mono float32 via ffmpeg.

    faster-whisper decodes through PyAV, but faster-whisper 1.2.1 passes
    ``metadata_errors=`` to ``av.open()``, which PyAV removed in 15.0 —
    so decoding here keeps the worker working with any PyAV version.
    """
    import numpy as np

    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32)


def transcribe_faster_whisper(path: str, model_name: str, language):
    """Transcribe an audio file; returns chunk-relative segments with word times."""
    model = get_faster_whisper_model(model_name)
    audio = decode_audio_ffmpeg(path)
    segments, _info = model.transcribe(audio, language=language, word_timestamps=True, beam_size=5)
    out = []
    for seg in segments:
        words = []
        for w in seg.words or []:
            words.append({"text": w.word.strip(), "start": float(w.start), "end": float(w.end)})
        out.append({
            "text": seg.text.strip(),
            "start": float(seg.start),
            "end": float(seg.end),
            "words": words,
        })
    return out


# ---- whisperjav backend (WhisperJAV StableTSASR, turbo mode) ----
_whisperjav_cache = {}
_whisperjav_available = None


def is_engine_available(engine: str) -> bool:
    """True when this worker can run the engine. faster-whisper is a hard
    dependency, so always True; whisperjav is True only when the
    WhisperJAV package imports (result cached — the import pulls torch)."""
    global _whisperjav_available
    if engine == "faster-whisper":
        return True
    if engine == "whisperjav":
        if _whisperjav_available is None:
            try:
                from whisperjav.modules.stable_ts_asr import StableTSASR  # noqa: F401

                _whisperjav_available = True
            except Exception as e:  # noqa: BLE001 - any import failure means unavailable
                log.info("whisperjav engine unavailable: %s", e)
                _whisperjav_available = False
        return _whisperjav_available
    return False


def _get_whisperjav_asr(model_name: str, language):
    """One StableTSASR instance per (model, language): the model stays
    resident in the worker process, like the faster-whisper cache."""
    key = (model_name, language)
    if key not in _whisperjav_cache:
        from whisperjav.modules.stable_ts_asr import StableTSASR

        model_config = {"model_name": model_name, "device": "cpu", "compute_type": "int8"}
        if model_name in _FASTER_WHISPER_REPOS:
            model_config["hf_repo"] = _FASTER_WHISPER_REPOS[model_name]
        # language None = auto-detect (stable-ts passes it through to
        # faster-whisper); a code transcribes in that language.
        params = {
            "decoder": {"language": language, "beam_size": 5},
            "provider": {},
            "stable_ts": {},
        }
        log.info("Loading WhisperJAV (stable-ts) model %s (CPU, int8)", model_name)
        _whisperjav_cache[key] = StableTSASR(
            model_config=model_config, params=params, task="transcribe", turbo_mode=True
        )
    return _whisperjav_cache[key]


def _word_field(word, name):
    """Word timing from a stable-ts WordTiming (attributes) or a plain dict."""
    if isinstance(word, dict):
        return word.get(name)
    return getattr(word, name, None)


def _map_stable_ts_segment(seg):
    words = []
    for w in getattr(seg, "words", None) or []:
        text = _word_field(w, "word")
        start = _word_field(w, "start")
        end = _word_field(w, "end")
        if text is None or start is None or end is None:
            continue
        words.append({"text": str(text).strip(), "start": float(start), "end": float(end)})
    return {
        "text": (getattr(seg, "text", "") or "").strip(),
        "start": float(getattr(seg, "start", 0.0)),
        "end": float(getattr(seg, "end", 0.0)),
        "words": words,
    }


def transcribe_whisperjav(path: str, model_name: str, language):
    """Transcribe via WhisperJAV's StableTSASR; returns chunk-relative
    segments with word times, in Lantern's shape."""
    asr = _get_whisperjav_asr(model_name, language)
    result = asr.transcribe(path)
    out = [_map_stable_ts_segment(seg) for seg in (result.segments or [])]
    if out and not any(seg["words"] for seg in out):
        # Words are the whole reason this engine exists (merge + resegment
        # need them); log loudly instead of silently degrading to fuzzy merge.
        log.warning("whisperjav returned %d segments with no word timestamps for %s", len(out), path)
    return out


# ---- dispatch ----
def transcribe_file(path: str, model_name: str, language, engine: str = DEFAULT_ENGINE):
    """Transcribe an audio file with the chosen engine."""
    if engine not in ENGINES:
        raise ValueError(f"unknown transcription engine: {engine}")
    if engine == "whisperjav":
        return transcribe_whisperjav(path, model_name, language)
    return transcribe_faster_whisper(path, model_name, language)
