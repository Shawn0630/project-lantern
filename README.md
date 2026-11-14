# LanTask

A LAN distributed task platform. The manager splits work into tasks and
hands them out; workers on any machine on the LAN pull tasks, do the
compute, and report results. First workload: video translation /
transcription (transcribe → merge → translate → subtitle synthesis).

## Architecture

```
                  ┌──────────────┐  poll /api/tasks/next   ┌──────────────┐
                  │   Manager    │ ◄────────────────────── │   Worker A   │
                  │  (Node, :9400)│  download task input    │ (faster-    │
                  │  Express +   │ ──────────────────────► │  whisper +   │
                  │  file state  │  POST /api/tasks/:id/   │  Gemini)     │
                  │  data/jobs/  │  result                 └──────────────┘
                  └──────────────┘
                         ▲  poll /api/tasks/next   ┌──────────────┐
                         └──────────────────────── │   Worker B   │
                                                    └──────────────┘
```

- **Manager** (`manager/`, Node ESM + Express, no database — JSON files
  under `data/`). Owns the job pipeline, the task queue, and the merge /
  synthesize steps. It never dials workers: workers poll it (worker-pull
  model), so workers can sit behind NAT/firewalls as long as they can
  reach the manager.
- **Worker** (`worker/`, Python 3.12, FastAPI + faster-whisper). Polls
  the manager, downloads chunk audio, transcribes locally with word
  timestamps, translates via Gemini REST, uploads JSON results.
  Serves a small `/health` API on its own port.

### Job pipeline (one video)

1. **Upload** — multipart upload to `data/jobs/<id>/input/`; ffprobe
   reads duration.
2. **Prepare** — ffmpeg extracts 16 kHz mono WAV, then splits it into
   chunks (default 10 min, 10 s overlap, configurable per job).
3. **Transcribe** — one task per chunk. Workers run faster-whisper with
   word timestamps on.
4. **Merge** (manager) — chunk segments are offset to absolute time and
   merged pairwise. In the overlap region a sliding window finds the
   best text alignment (word-level exact match preferred; sentence-level
   fuzzy match with similarity > 0.7 and at least 2 matches); the merge
   cuts at the midpoint of the matched span so overlap text appears
   once. No match → time-boundary fallback (keep left segments ending
   before the first right segment starts).
5. **Re-segment** (manager, optional LLM) — if word timestamps exist,
   words are regrouped into sentence-like segments (cut after terminal
   punctuation, max 25 words / 8 s). Otherwise, when an LLM key is
   configured, a text-only polish runs that must preserve segment count
   and boundaries. Without words and without a key, this step is skipped.
6. **Translate** — merged segments are grouped (~20 per task) and
   distributed to workers. The worker calls Gemini with a numbered-lines
   prompt and must return exactly the same number of lines; the manager
   verifies counts on merge and retries a mismatched task once.
7. **Synthesize** (manager) — ffmpeg burns the subtitles into
   `video.mp4` (ASS styling, clean white-on-black-outline) and muxes a
   soft-sub `soft.mp4`. `source.srt` and `translated.srt` are always
   emitted (plus `bilingual.srt` when enabled).

Task states: `queued → assigned → done/failed`. A failed task retries
once, preferring a different worker (the preference expires after 60 s so
a single-worker setup can still retry). Assignments silent for 15 minutes
are re-queued by a sweeper.

## Run

```bash
cp server/.env.example server/.env   # fill in LLM_API_KEY (optional but needed for translation)
docker compose up -d --build
# Manager UI: http://localhost:9400
# Worker health: http://localhost:9500/health
```

Without Docker, run natively:

```bash
cd manager && npm install && npm start          # :9400
cd worker && python -m venv .venv && .venv/bin/pip install -r requirements.txt
MANAGER_URL=http://127.0.0.1:9400 WORKER_PORT=9500 .venv/bin/python worker.py
```

## Add a LAN worker

On any machine on the same network (Docker):

```bash
docker run -d --name lantask-worker -p 9500:9500 \
  -e MANAGER_URL=http://<MANAGER_LAN_IP>:9400 \
  -e WORKER_PORT=9500 \
  -e WHISPER_MODEL=small \
  -v whisper-models:/models \
  lantask-worker
```

Or natively: `MANAGER_URL=http://<MANAGER_LAN_IP>:9400 WORKER_PORT=9500 python worker.py`.
The worker registers itself via heartbeat; it also appears in the
Workers page. To give it a name up front, use the Workers page
(Add worker) or set `WORKER_NAME`.

## Job options (per job)

| Option | Default | Notes |
| --- | --- | --- |
| Source language | auto | Whisper auto-detect |
| Target language | zh-CN | |
| Whisper model | small | tiny for tests; large-v3 for quality |
| Chunk minutes | 10 | 0.5–120 |
| Overlap seconds | 10 | must be < chunk length |
| Translate | on | off = transcription only |
| Burn-in subtitles | on | off = soft-sub mp4 only |
| Bilingual subtitles | off | source + target lines |

## v1 limits

- The Gemini API key is passed to workers inside translate task payloads
  (LAN-trusted v1 simplification — only run workers you trust).
- Translation needs network access to Google's Gemini API from the worker.
- Burn-in / muxing runs on the manager (CPU ffmpeg).
- No TTS/dubbing, no speaker diarization, no VAD.
- The manager stores all state as JSON files under `data/`; there is no
  authentication on the API (LAN use only).
- Translation is skipped when no `LLM_API_KEY` is configured; the job
  still completes transcription + subtitles.

## Tests

```bash
cd manager && npm test        # node --test (chunk plan, merger, SRT, translate, resegment, multipart, LLM)
cd worker && .venv/bin/python -m pytest tests/ -q
```

## Verification

See [PROBE.md](PROBE.md) for the end-to-end probe (real video, real
whisper transcription, stubbed Gemini translation) with commands and
outputs.
