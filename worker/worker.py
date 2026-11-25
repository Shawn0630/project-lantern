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
  WORKER_ID     stable id (default: persisted id, see below)
  WORKER_NAME   display name (default: hostname)
  WORKER_HOST   host reported to the manager (default: hostname)
  WORKER_DATA_DIR directory holding the persisted worker id
                (default ~/.lantern; in Docker set to /data, backed by
                the worker-data volume, so a container recreate keeps
                the same id and the manager shows one row per machine)
  WHISPER_MODEL default faster-whisper model (default large-v3)
  HF_HOME       Hugging Face cache dir for downloaded models

Identity: the worker id is stable per machine, not per container.
On first boot it is generated and stored in
``$WORKER_DATA_DIR/worker-id``; later boots reuse it, so a redeploy
(container recreate with a new hostname) heartbeats as the same
worker and the manager updates the existing row instead of adding
a new one. WORKER_ID overrides the file when explicitly set.
NOTE: two worker containers sharing one WORKER_DATA_DIR would share
one id and fight over it — give each worker its own volume.
BOOT_ID is a fresh random id per process start, sent with every
heartbeat so the manager can tell a restart (new incarnation, same
stable id) from the same process still running.
"""
import logging
import os
import shutil
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path

import requests
from fastapi import FastAPI
import uvicorn

from gemini import translate_lines
import burnin
from transcribe_core import (
    DEFAULT_ENGINE,
    ENGINES,
    is_engine_available,
    loaded_faster_whisper_models,
    transcribe_file,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("lantern-worker")

VERSION = "1.4.0"
MANAGER_URL = os.environ.get("MANAGER_URL", "").rstrip("/")
WORKER_PORT = int(os.environ.get("WORKER_PORT", "9500"))
WORKER_HOST = os.environ.get("WORKER_HOST", socket.gethostname())
WORKER_NAME = os.environ.get("WORKER_NAME", socket.gethostname())


def resolve_worker_id():
    """Stable id for this machine. WORKER_ID wins when set; otherwise
    generate once and persist it in $WORKER_DATA_DIR/worker-id so the
    id survives container recreates (the data dir is a volume)."""
    if os.environ.get("WORKER_ID"):
        return os.environ["WORKER_ID"]
    data_dir = Path(os.environ.get("WORKER_DATA_DIR") or (Path.home() / ".lantern"))
    id_file = data_dir / "worker-id"
    try:
        existing = id_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    new_id = uuid.uuid4().hex
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        tmp = data_dir / "worker-id.tmp"
        tmp.write_text(new_id + "\n", encoding="utf-8")
        os.replace(tmp, id_file)
    except OSError:
        log.warning("could not persist worker id in %s; using an ephemeral id", data_dir)
        return new_id
    return new_id


WORKER_ID = resolve_worker_id()
# Fresh per process start (never persisted): lets the manager tell a
# worker restart apart from the same process still running.
BOOT_ID = uuid.uuid4().hex
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
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
        "models": models_report(),
        "current_task": _state["current_task"],
    }


@app.get("/info")
def info():
    return {"worker_id": WORKER_ID, "name": WORKER_NAME, "host": WORKER_HOST, "port": WORKER_PORT}


# ---- transcription core (faster-whisper + WhisperJAV; see transcribe_core.py) ----
# Model loading/decoding lives in transcribe_core; this module keeps the
# heartbeat's view of it (loaded faster-whisper models + engines offered).


def engines_report():
    """Transcription engines this worker can run. faster-whisper is always
    available; whisperjav only when the WhisperJAV package imports
    (checked once, cached in transcribe_core)."""
    return [e for e in ENGINES if is_engine_available(e)]


# Known faster-whisper model repos (mirrors faster_whisper.utils._MODELS):
# HF repo id -> canonical model name shown on the Workers page and
# accepted as a per-worker pin. Aliases ('large', 'turbo') resolve to
# the same repo as their canonical name, so they are not listed twice.
FASTER_WHISPER_REPOS = {
    "Systran/faster-whisper-tiny.en": "tiny.en",
    "Systran/faster-whisper-tiny": "tiny",
    "Systran/faster-whisper-base.en": "base.en",
    "Systran/faster-whisper-base": "base",
    "Systran/faster-whisper-small.en": "small.en",
    "Systran/faster-whisper-small": "small",
    "Systran/faster-whisper-medium.en": "medium.en",
    "Systran/faster-whisper-medium": "medium",
    "Systran/faster-whisper-large-v1": "large-v1",
    "Systran/faster-whisper-large-v2": "large-v2",
    "Systran/faster-whisper-large-v3": "large-v3",
    "Systran/faster-distil-whisper-large-v2": "distil-large-v2",
    "Systran/faster-distil-whisper-medium.en": "distil-medium.en",
    "Systran/faster-distil-whisper-small.en": "distil-small.en",
    "Systran/faster-distil-whisper-large-v3": "distil-large-v3",
    "distil-whisper/distil-large-v3.5-ct2": "distil-large-v3.5",
    "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "large-v3-turbo",
}


def hf_hub_dir():
    """Hugging Face hub cache dir: HF_HUB_CACHE wins, else $HF_HOME/hub
    (in Docker HF_HOME=/models, backed by the whisper-models volume)."""
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    home = os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface")
    return Path(home) / "hub"


def list_downloaded_models():
    """Whisper models present on disk: in-memory cache keys plus any
    known faster-whisper model repo in the HF hub cache with a complete
    snapshot (model.bin present — huggingface_hub only moves the file
    into place once fully downloaded). Never raises: the heartbeat
    must survive a broken cache dir."""
    found = set(loaded_faster_whisper_models())
    try:
        hub = hf_hub_dir()
        if hub.is_dir():
            for repo_dir in hub.glob("models--*"):
                name = repo_dir.name[len("models--"):]
                parts = name.split("--", 1)
                if len(parts) != 2:
                    continue
                model = FASTER_WHISPER_REPOS.get(f"{parts[0]}/{parts[1]}")
                if not model:
                    continue
                for snap in (repo_dir / "snapshots").glob("*"):
                    if (snap / "model.bin").is_file():
                        found.add(model)
                        break
    except OSError:
        pass
    return sorted(found)


def models_report():
    """Heartbeat/health view of this worker's models."""
    return {"loaded": _state["model"], "available": list_downloaded_models()}


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
            "bootId": BOOT_ID,
            "host": WORKER_HOST,
            "port": WORKER_PORT,
            "name": WORKER_NAME,
            "load": 1 if _state["current_task"] else 0,
            "model": _state["model"] or DEFAULT_MODEL,
            "models": models_report(),
            "engines": engines_report(),
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


def download_repo_video(video_id: str, dest=None):
    """Download a repo video from the manager, resuming a partial file.

    Plain HTTP GET on /api/repo/videos/:id — no session or browser
    needed. When `dest` already holds a prefix of the file, the
    request carries Range: bytes=<have>- and the rest is appended,
    so a large download resumes instead of restarting. When the
    server answers 200 instead of 206 (range ignored), the file is
    rewritten from scratch. Returns the path of the complete file."""
    url = f"{MANAGER_URL}/api/repo/videos/{video_id}"
    dest = Path(dest) if dest else Path(tempfile.gettempdir()) / f"lantern-repo-{video_id}"
    have = dest.stat().st_size if dest.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with requests.get(url, headers=headers, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        if resp.status_code == 206:
            mode = "ab"
        elif resp.status_code == 200:
            mode = "wb"  # server ignored the range: restart from scratch
        else:
            raise RuntimeError(f"repo download rejected: {resp.status_code}")
        with open(dest, mode) as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    return str(dest)


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
        model = task.get("model") or DEFAULT_MODEL
        engine = task.get("engine") or DEFAULT_ENGINE
        segments = transcribe_file(data, model, task.get("sourceLang"), engine=engine)
        _state["model"] = model
        log.info("transcribed task %s: %d segments (engine=%s)", task["taskId"], len(segments), engine)
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
