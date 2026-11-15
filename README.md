# Lantern

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
  Serves a small `/health` API on its own port. Each worker advertises
  its capabilities on every heartbeat (`transcribe`, `translate`, and
  `burnin` when ffmpeg is on PATH) plus host load stats; the heartbeat
  runs on its own thread so a long task never makes the worker look dead.
  Load stats come from `psutil` when installed (a real dependency);
  on Linux the worker falls back to `/proc/meminfo` + load average, but
  on Windows `psutil` is the only source — without it the manager's
  Resources column stays blank.

### Scheduler (v1.2 — same worker-pull model, no new services)

- **Capabilities.** Every task type declares its required capability
  (`transcribe` / `translate` / `burnin`); `GET /api/tasks/next` only
  offers tasks the requesting worker can do. Workers that never report
  capabilities are assumed able to do everything (back-compat).
- **Weights.** Each task carries a base `weight` (0 for now). The `next`
  query orders by effective weight DESC, then `queuedAt` ASC. A job that
  already started (any task done or assigned) gives its remaining tasks
  +1, so a started job finishes instead of interleaving with a new one.
- **Acked assignment.** Claiming reserves a task but counts no attempt.
  The worker acks receipt immediately (`POST /api/tasks/:id/ack`); the
  ack counts the attempt. An assignment never acked within 45 s
  (`ACK_TIMEOUT_MS`) is re-offered by a 10 s sweep, without consuming a
  try. Assignments silent for 15 minutes are re-queued by a sweeper
  (backstop).
- **Boot reconciliation.** On startup the manager immediately sweeps
  stale assignments, and 30 s later re-checks every assigned task
  against worker heartbeats: tasks of workers silent for 45 s+
  (`WORKER_SILENT_MS`) are re-queued and those workers marked offline.
  No task is lost across a manager restart.
- **Per-stage retry budgets.** The scheduler only records failures; the
  pipeline decides by task type: transcribe 2 attempts, translate 3,
  burn-in 1. A failed task prefers another worker (exclusion expires
  after 60 s so a single-worker setup can still retry).
- **Concurrency cap.** At most 16 simultaneous in-flight (assigned)
  tasks by default (`MAX_IN_FLIGHT_TASKS` env); `next` returns nothing
  above the cap.

Task states: `queued → assigned → done/failed` (assigned splits into
un-acked / acked). Manager and worker must be updated together: v1.2
workers ack claims, and a v1.2 manager re-offers tasks a v1.1 worker
never acks.

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
7. **Burn-in** (workers) — the manager splits the video into burn
   segments (~5 min each, `burnChunkMin`, boundaries snapped into
   subtitle gaps so no line is ever cut in half), cuts each segment with
   ffmpeg stream copy, and hands one `burnin` task per segment to a
   worker (segment video + per-segment ASS with times shifted to the
   segment). The worker burns with libx264 CRF 20, re-encoding audio to
   AAC, keeping the source resolution and frame rate exactly. A failed
   segment retries only that segment. The manager verifies all burned
   segments share codec/resolution/fps, then concatenates them
   (stream copy, no re-encode) into `video.mp4`.
8. **Soft-sub** (manager) — `soft.mp4` muxes the SRT as a mov_text
   track (stream copy). `source.srt` and `translated.srt` are always
   emitted (plus `bilingual.srt` when enabled).

Task states: `queued → assigned → done/failed`. See "Scheduler (v1.2)"
above for weights, ack, retry budgets, and the concurrency cap.

## Run

```bash
cp server/.env.example server/.env   # fill in LLM_API_KEY (optional but needed for translation)
docker compose up -d --build
# Manager UI: http://localhost:9400
# Worker health: http://localhost:9500/health
```

Manager knobs (environment): `MAX_IN_FLIGHT_TASKS` (default 16),
`ACK_TIMEOUT_MS` (default 45000).

Without Docker, run natively:

```bash
cd manager && npm install && npm start          # :9400
cd worker && python -m venv .venv && .venv/bin/pip install -r requirements.txt
MANAGER_URL=http://127.0.0.1:9400 WORKER_PORT=9500 .venv/bin/python worker.py
```

## Add a LAN worker

On any machine on the same network, the one-command way is the
worker-only compose file (Docker):

```bash
git clone https://github.com/Shawn0630/project-lantern.git
cd project-lantern
MANAGER_URL=http://<MANAGER_LAN_IP>:9400 docker compose -f docker-compose.worker.yml up -d --build
```

`MANAGER_URL` is the manager's LAN address (e.g. `http://192.168.1.5:9400` —
find the Mac's IP in System Settings → Wi-Fi). It is required: the command
fails loudly if it is unset. Or put `MANAGER_URL=http://<MANAGER_LAN_IP>:9400`
in a `.env` file next to the compose file and run the command without the
inline variable. `WHISPER_MODEL` defaults to `large-v3` (`large-v3-turbo` for speed,
`tiny` for tests). No port is published: the manager never dials the
worker (worker-pull only). The `worker-data` volume holds the worker's
stable id, so a redeploy reuses the same Workers row instead of
registering a new one.

Or with plain `docker run` (same idea, more flags):

```bash
docker build -t lantern-worker ./worker
docker run -d --name lantern-worker \
  -e MANAGER_URL=http://<MANAGER_LAN_IP>:9400 \
  -e WORKER_PORT=9500 \
  -e WHISPER_MODEL=large-v3 \
  -e WORKER_DATA_DIR=/data \
  -v whisper-models:/models \
  -v lantern-worker-data:/data \
  lantern-worker
```

Or natively: `MANAGER_URL=http://<MANAGER_LAN_IP>:9400 WORKER_PORT=9500 python worker.py`.
The worker registers itself via heartbeat; it also appears in the
Workers page, which shows each worker's status, current task
(job + task type + segment), capabilities, and Resources
(CPU%, memory, load). To give it a name up front, use the Workers page
(Add worker) or set `WORKER_NAME`.

## Job options (per job)

| Option | Default | Notes |
| --- | --- | --- |
| Source language | auto | Whisper auto-detect |
| Target language | zh-CN | |
| Whisper model | large-v3 | large-v3-turbo for speed; tiny for tests |
| Chunk minutes | 10 | 0.5–120 |
| Overlap seconds | 10 | must be < chunk length |
| Burn chunk minutes | 5 | 0.5–120; boundaries snap to subtitle gaps |
| Translate | on | off = transcription only |
| Burn-in subtitles | on | off = soft-sub mp4 only |
| Bilingual subtitles | off | source + target lines |

## v1 limits

- The Gemini API key is passed to workers inside translate task payloads
  (LAN-trusted v1 simplification — only run workers you trust).
- Translation needs network access to Google's Gemini API from the worker.
- Burn-in is distributed: workers burn segments; the manager only cuts
  segments and concatenates. The manager never runs a burn-in encode.
- No TTS/dubbing, no speaker diarization, no VAD.
- The manager stores all state as JSON files under `data/`; there is no
  authentication on the API (LAN use only).
- Translation is skipped when no `LLM_API_KEY` is configured; the job
  still completes transcription + subtitles.

## Tests

```bash
cd manager && npm test        # node --test (chunk plan, merger, SRT, translate, resegment, multipart, LLM, scheduler)
cd worker && .venv/bin/python -m pytest tests/ -q
```

## Verification

See [PROBE.md](PROBE.md) for the end-to-end probe (real video, real
whisper transcription, stubbed Gemini translation) with commands and
outputs.
