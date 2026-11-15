"""Lantern worker: polls the manager for tasks, runs faster-whisper
transcription and Gemini translation, and reports results.

The worker never accepts inbound task assignments; it pulls work from the
manager (GET /api/tasks/next), acks receipt of a claimed task immediately
(POST /api/tasks/:id/ack), and serves only a small health API locally.
It advertises its capabilities (transcribe / translate / burnin) and host
load stats on every heartbeat; the heartbeat runs on its own thread so a
long task does not make the worker look dead.

Environment:
  MANAGER_URL   manager base URL, e.g. http://192.168.1.5:9400 (required)
  WORKER_PORT   local health-API port (default 9500)
  WORKER_ID     stable id (default: hostname-port)
  WORKER_NAME   display name (default: hostname)
  WORKER_HOST   host reported to the manager (default: hostname)
  WHISPER_MODEL default faster-whisper model (default small)
  HF_HOME       Hugging Face cache dir for downloaded models
"""
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import requests
from fastapi import FastAPI
import uvicorn

from gemini import translate_lines
import burnin

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("lantern-worker")

VERSION = "1.2.0"
MANAGER_URL = os.environ.get("MANAGER_URL", "").rstrip("/")
WORKER_PORT = int(os.environ.get("WORKER_PORT", "9500"))
WORKER_HOST = os.environ.get("WORKER_HOST", socket.gethostname())
WORKER_NAME = os.environ.get("WORKER_NAME", socket.gethostname())
WORKER_ID = os.environ.get("WORKER_ID", f"{WORKER_HOST}-{WORKER_PORT}")
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "small")
HEARTBEAT_INTERVAL = 15
POLL_INTERVAL = 2

app = FastAPI(title="Lantern Worker")
_state = {"current_task": None, "model": None}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "worker_id": WORKER_ID,
        "version": VERSION,
        "model": _state["model"],
        "current_task": _state["current_task"],
    }


@app.get("/info")
def info():
    return {"worker_id": WORKER_ID, "name": WORKER_NAME, "host": WORKER_HOST, "port": WORKER_PORT}


# ---- faster-whisper (lazy import so --help/health work without the model stack) ----
_model_cache = {}


def get_model(model_name: str):
    if model_name not in _model_cache:
        from faster_whisper import WhisperModel

        log.info("Loading faster-whisper model %s (CPU, int8)", model_name)
        _model_cache[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
        _state["model"] = model_name
    return _model_cache[model_name]


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


def transcribe_file(path: str, model_name: str, language):
    """Transcribe an audio file; returns chunk-relative segments with word times."""
    model = get_model(model_name)
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


def capabilities():
    """Task kinds this worker can do. Burn-in needs ffmpeg on PATH."""
    caps = ["transcribe", "translate"]
    if shutil.which("ffmpeg"):
        caps.append("burnin")
    return caps


def collect_stats():
    """Best-effort host load stats for the heartbeat. No new dependencies:
    psutil when installed, else load average + /proc/meminfo on Linux.
    Missing values stay None."""
    stats = {"loadAvg1": None, "cpuPercent": None, "memUsedMb": None, "memTotalMb": None}
    try:
        load1, _, _ = os.getloadavg()
        stats["loadAvg1"] = round(load1, 2)
    except OSError:
        pass
    try:
        import psutil

        stats["cpuPercent"] = round(psutil.cpu_percent(interval=None), 1)
        mem = psutil.virtual_memory()
        stats["memUsedMb"] = round(mem.used / (1024 * 1024))
        stats["memTotalMb"] = round(mem.total / (1024 * 1024))
        return stats
    except ImportError:
        pass
    try:
        meminfo = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    meminfo[parts[0][:-1]] = int(parts[1])
        if "MemTotal" in meminfo and "MemAvailable" in meminfo:
            stats["memTotalMb"] = round(meminfo["MemTotal"] / 1024)
            stats["memUsedMb"] = round((meminfo["MemTotal"] - meminfo["MemAvailable"]) / 1024)
    except OSError:
        pass
    return stats


# ---- manager client ----
def manager_post(path, payload, timeout=30):
    return requests.post(f"{MANAGER_URL}{path}", json=payload, timeout=timeout)


def heartbeat():
    try:
        resp = manager_post("/api/workers/heartbeat", {
            "id": WORKER_ID,
            "host": WORKER_HOST,
            "port": WORKER_PORT,
            "name": WORKER_NAME,
            "load": 1 if _state["current_task"] else 0,
            "model": _state["model"] or DEFAULT_MODEL,
            "version": VERSION,
            "capabilities": capabilities(),
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "stats": collect_stats(),
        })
        if resp.status_code != 200:
            log.warning("heartbeat rejected: %s %s", resp.status_code, resp.text[:200])
    except requests.RequestException as e:
        log.warning("heartbeat failed: %s", e)


def heartbeat_loop():
    while True:
        heartbeat()
        time.sleep(HEARTBEAT_INTERVAL)


def ack_task(task_id: str):
    """Confirm receipt of a claimed task. Returns True when the manager
    still holds the assignment for us; False means it was re-offered (or
    the ack could not be delivered) — the task must not be run."""
    try:
        resp = manager_post(f"/api/tasks/{task_id}/ack", {"workerId": WORKER_ID}, timeout=10)
    except requests.RequestException as e:
        log.warning("ack %s failed: %s", task_id, e)
        return False
    if resp.status_code != 200:
        log.warning("ack %s rejected: %s %s", task_id, resp.status_code, resp.text[:200])
        return False
    return True


def claim(task_type: str):
    try:
        resp = requests.get(
            f"{MANAGER_URL}/api/tasks/next",
            params={"type": task_type, "workerId": WORKER_ID},
            timeout=30,
        )
    except requests.RequestException as e:
        log.warning("claim %s failed: %s", task_type, e)
        return None
    if resp.status_code == 204:
        return None
    if resp.status_code != 200:
        log.warning("claim %s rejected: %s %s", task_type, resp.status_code, resp.text[:200])
        return None
    task = resp.json()
    if not ack_task(task["taskId"]):
        return None
    return task


def download_input(task):
    """Download a task's input. Returns (kind, data): file path or JSON payload."""
    resp = requests.get(f"{MANAGER_URL}{task['inputUrl']}", timeout=120)
    resp.raise_for_status()
    if task.get("inputKind") == "json":
        return "json", resp.json()
    suffix = Path(task.get("inputUrl", "input.wav")).suffix or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            tmp.write(chunk)
    finally:
        tmp.close()
    return "file", tmp.name


def report_result(task_id: str, status: str, result=None, error=None):
    payload = {"workerId": WORKER_ID, "status": status}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    try:
        resp = manager_post(f"/api/tasks/{task_id}/result", payload, timeout=30)
        if resp.status_code != 200:
            log.warning("result for %s rejected: %s %s", task_id, resp.status_code, resp.text[:200])
    except requests.RequestException as e:
        log.warning("result for %s failed to send: %s", task_id, e)


def download_url(rel_url, suffix):
    """Download a manager-relative URL to a temp file; returns its path."""
    resp = requests.get(f"{MANAGER_URL}{rel_url}", timeout=300)
    resp.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            tmp.write(chunk)
    finally:
        tmp.close()
    return tmp.name


def upload_result_file(task_id, path):
    """Upload a burned segment file as the task result (multipart)."""
    with open(path, "rb") as fh:
        resp = requests.post(
            f"{MANAGER_URL}/api/tasks/{task_id}/result-file",
            files={"file": (os.path.basename(path), fh, "video/mp4")},
            data={"workerId": WORKER_ID, "status": "done"},
            timeout=300,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"result upload rejected: {resp.status_code} {resp.text[:200]}")


def run_burnin(task):
    kind, payload = download_input(task)
    assert kind == "json"
    video_path = download_url(payload["videoUrl"], ".mp4")
    ass_path = download_url(payload["assUrl"], ".ass")
    out_path = None
    try:
        out_path = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4").name
        burnin.burnin_segment(video_path, ass_path, out_path, payload)
        log.info("burned task %s: segment %s", task["taskId"], payload.get("duration"))
        upload_result_file(task["taskId"], out_path)
    finally:
        for p in (video_path, ass_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def run_transcribe(task):
    kind, data = download_input(task)
    assert kind == "file"
    try:
        segments = transcribe_file(data, task.get("model") or DEFAULT_MODEL, task.get("sourceLang"))
        log.info("transcribed task %s: %d segments", task["taskId"], len(segments))
        report_result(task["taskId"], "done", {"segments": segments})
    finally:
        try:
            os.unlink(data)
        except OSError:
            pass


def run_translate(task):
    kind, payload = download_input(task)
    assert kind == "json"
    api_key = payload.get("llmApiKey")
    if not api_key:
        raise RuntimeError("translate task has no LLM API key (manager LLM not configured)")
    lines = translate_lines(
        [s["text"] for s in payload["segments"]],
        payload.get("sourceLang") or "auto",
        payload.get("targetLang") or "zh-CN",
        api_key,
        payload.get("llmModel") or "gemini-2.5-flash",
    )
    result_lines = [
        {"index": seg["index"], "text": text}
        for seg, text in zip(payload["segments"], lines)
    ]
    log.info("translated task %s: %d lines", task["taskId"], len(result_lines))
    report_result(task["taskId"], "done", {"lines": result_lines})


def poll_loop():
    log.info("worker %s polling %s", WORKER_ID, MANAGER_URL)
    while True:
        try:
            task = claim("transcribe") or claim("translate") or claim("burnin")
            if not task:
                time.sleep(POLL_INTERVAL)
                continue
            _state["current_task"] = task["taskId"]
            try:
                if task["type"] == "transcribe":
                    run_transcribe(task)
                elif task["type"] == "translate":
                    run_translate(task)
                elif task["type"] == "burnin":
                    run_burnin(task)
                else:
                    report_result(task["taskId"], "failed", error=f"unknown task type {task['type']}")
            except Exception as e:  # noqa: BLE001 - a task failure must not kill the loop
                log.exception("task %s failed", task["taskId"])
                report_result(task["taskId"], "failed", error=str(e))
            finally:
                _state["current_task"] = None
        except Exception:  # noqa: BLE001 - keep polling through unexpected errors
            log.exception("poll loop error")
            time.sleep(POLL_INTERVAL)


def main():
    if not MANAGER_URL:
        raise SystemExit("MANAGER_URL is required (e.g. http://192.168.1.5:9400)")
    # Heartbeat on its own thread: a long task must not make the worker
    # look dead to the manager's liveness checks.
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    thread = threading.Thread(target=poll_loop, daemon=True)
    thread.start()
    uvicorn.run(app, host="0.0.0.0", port=WORKER_PORT, log_level="warning")


if __name__ == "__main__":
    main()
