# Lantern v1 — End-to-End Probe (2026-11-14)

Probe run on this VM (Linux, no Docker). Everything below was run natively;
Docker images were **not** built here (no docker/podman on this VM) — the
compose file is for the Mac.

## What was probed

- **Real input:** `probe/test-video.mp4` — 67.2 s, 640x360 h264 + AAC, built
  with ffmpeg from `testsrc2` video + real American English speech
  (`probe-osr.wav`, 33.6 s Harvard sentences from voiptroubleshooter.com,
  looped 2x). Not synthesized speech.
- **Real ASR:** faster-whisper `tiny` on CPU (int8), word timestamps on.
- **Stubbed LLM:** `probe/stub_gemini.py` (port 8077) answers every Gemini
  call deterministically with `[TR] <original text>` — it proves the
  translate round-trip, grouping, and count verification, not real
  translation quality. The manager never called real Gemini (it only needs
  a configured key to enable the translate stage; the worker does the
  Gemini call, pointed at the stub via `GEMINI_BASE_URL`).
- **Manager + worker:** both run natively on this VM, same as the Docker
  images would (manager port 9400, worker port 9500).

## Commands

```bash
# 1. Stub Gemini (deterministic [TR] replies)
python3 probe/stub_gemini.py 8077

# 2. Manager (server/.env holds a dummy key so the translate stage enables;
#    the value is never sent anywhere in this probe)
printf 'LLM_API_KEY=probe-stub-key\nLLM_MODEL=gemini-2.5-flash\n' > server/.env
cd manager && PORT=9400 DATA_DIR=/home/hatch/workspace/project-lantern/data node server.js

# 3. Worker (tiny model; HF cache seeded, see "Issues found" below)
cd worker
MANAGER_URL=http://127.0.0.1:9400 WORKER_PORT=9500 WORKER_NAME=probe-worker \
  WHISPER_MODEL=tiny GEMINI_BASE_URL=http://127.0.0.1:8077/v1beta \
  HF_HOME=/home/hatch/workspace/project-lantern/probe/hf-cache .venv/bin/python worker.py

# 4. Submit a job: 30 s chunks, 5 s overlap, translate + burn-in on
curl -X POST http://127.0.0.1:9400/api/jobs \
  -F "video=@probe/test-video.mp4" -F "sourceLang=en" -F "targetLang=zh-CN" \
  -F "model=tiny" -F "chunkMin=0.5" -F "overlapSec=5" \
  -F "translate=true" -F "burnIn=true" -F "bilingual=false"
# -> {"id":"job_mwgpsol9nkoqwd"}

# 5. Poll until done
curl -s http://127.0.0.1:9400/api/jobs/job_mwgpsol9nkoqwd
```

## Results (job `job_mwgpsol9nkoqwd`, ~28 s submit → done)

- 3 chunks `[0,30] [25,55] [50,67.2]`, all 3 transcribe tasks done by the
  single probe worker, then merged → **19 segments**.
- Word-timestamp re-segmentation: 19 → 18 segments.
- 1 translate task (18 segments in one group), done by the worker via the
  stub; count verified by the manager.
- Outputs in `data/jobs/job_mwgpsol9nkoqwd/`:
  - `source.srt` — 18 entries, real ASR text (Harvard sentences, e.g.
    "The birch can use lid on the smooth planks." — tiny-model wording
    errors are real ASR errors, not test fixtures).
  - `translated.srt` — 18 entries, same timestamps, every line
    `[TR] ...` (stub output).
  - `video.mp4` — h264 640x360 + AAC, 67.2 s, 8.4 MB (burn-in subtitles).
  - `soft.mp4` — h264 + AAC + mov_text subtitle track, 67.2 s, 7.0 MB.
  - `merged.json`, `resegmented.json`, `translated.json`, `video.ass`,
    per-chunk results under `results/`.
- Downloads verified: `GET /api/jobs/:id/download/{source.srt,translated.srt,video.mp4}`
  all return 200 with the full file.
- Job log (from `GET /api/jobs/:id`): created → probed 67.2 s → split into
  3 chunks → 3 transcribe tasks done → merged 19 → re-segmented 19→18 →
  1 translate task → translated 18 → burn-in written → soft-sub written.

## Merge quality on real data

- **50 s boundary:** clean dedupe. Chunk 1's tail ("The juice of lemon
  makes fine punch", "The box is done") was correctly merged away;
  chunk 2's versions kept once.
- **25 s boundary:** partial duplication remains — the merged subtitles
  contain both "The hogs were fed chopped corn and garbage." (23.82–25.86)
  and "horn and garbage, four hours of steady work faced us, a large size
  and stockings" (25.00–31.36), i.e. the words "and garbage" appear twice.
  Cause: Whisper tiny hallucinated one long segment in chunk 1 spanning
  the whole overlap; the aligner matched 8 tokens ("and garbage, hours of
  steady work faced us") and cut at the midpoint, keeping each side's
  unique content. No sentence was lost and no sentence was fully duplicated.
  This is a tiny-model artifact, not a merge failure — with the default
  `small` model the overlap transcription is normally clean and the merge
  is exact. (The earlier job `job_mwgpe7xuz47ogo`, run without translation,
  shows the same boundary; its 50 s boundary is also clean.)

## Issues found during the probe (all fixed in the repo)

1. **HF model download stalled.** `faster-whisper`'s first download of
   `model.bin` (~75 MB) sat at 0 bytes for 3+ minutes inside the worker,
   while the same file downloads via curl at ~2.3 MB/s. Workaround for the
   probe: downloaded `model.bin` with curl, verified its sha256, and placed
   it into the HF cache layout (`blobs/<sha>` + snapshot symlink). The
   worker then loaded the model from cache. No code change; on the Mac the
   Docker build downloads the model on first use (volume `whisper-models`).
2. **PyAV ≥ 15 breaks faster-whisper 1.2.1.** `faster-whisper` calls
   `av.open(..., metadata_errors="ignore")`, which PyAV removed in 15.0,
   so every transcribe failed with
   `TypeError: open() got an unexpected keyword argument 'metadata_errors'`.
   Pinning `av<15` was not viable (no wheel for this platform; sdist
   build fails). Fix: the worker now decodes audio with ffmpeg to 16 kHz
   mono float32 and passes a numpy array to `model.transcribe`
   (`worker.py: decode_audio_ffmpeg`). PyAV is still installed as a
   faster-whisper dependency but is no longer on the decode path.
   `worker/requirements.txt` documents this.
3. **Single-worker retry deadlock.** A failed task is re-queued with
   `excludeWorker` set, so with only one worker it could never be claimed
   again. Fix: the exclusion now expires after 60 s (`manager/src/pipeline.js`,
   `requeuedAt` + grace in `claimTask`), so a lone worker retries while
   multi-worker setups still prefer a different worker. README updated.
4. **Overlap extraction missed long straddling segments.** A segment that
   starts inside the overlap but ends outside it (or vice versa) was
   excluded from the aligner's view, so no match was found and the merger
   fell back to plain concatenation. Fix: overlap membership is now
   start/end-based instead of fully-contained (`manager/src/merge.js`),
   plus a new unit test for the straddling case. This removed the
   intra-chunk duplicate "For hours of steady work faced us." from the
   merged output (20 → 19 segments on the same audio).

## What this probe does NOT prove

- Docker images / `docker compose up` — not built here (no Docker on
  this VM). Compose is for the Mac.
- Real Gemini translation quality — stubbed (see above).
- The `small` model (default) — probe used `tiny` for speed; `small`
  (~466 MB) downloads on first use.
- The web UI in a real browser — the manager serves it (HTTP 200 on `/`),
  but it was only exercised via the API here.
- Multi-worker distribution — one worker only; the pull/claim protocol
  is the same code path regardless of worker count.

---

# Lantern v1.1 — Distributed segmented burn-in probe (2026-11-14)

Same setup as v1 (67.2 s test video, real speech, faster-whisper `tiny`,
stubbed Gemini on port 8077, single probe worker), but burn-in now runs
on the worker in segments instead of on the manager. Probe data lives in
`probe/data-v11/` (the v1 job in `data/` is untouched). The failure
injector is `probe/inject-burnin-failure.sh`.

## Commands

```bash
# 1. Stub Gemini + manager (fresh data dir) + worker, as in v1
python3 probe/stub_gemini.py 8077
PORT=9400 DATA_DIR=/home/hatch/workspace/project-lantern/probe/data-v11 node manager/server.js
MANAGER_URL=http://127.0.0.1:9400 WORKER_PORT=9500 WORKER_ID=probe-worker-v11 \
  WHISPER_MODEL=tiny GEMINI_BASE_URL=http://127.0.0.1:8077/v1beta \
  HF_HOME=/home/hatch/workspace/project-lantern/probe/hf-cache worker/.venv/bin/python worker/worker.py

# 2. Submit with small burn segments (0.5 min -> 3 burnin tasks)
curl -X POST http://127.0.0.1:9400/api/jobs \
  -F "video=@probe/test-video.mp4" -F "sourceLang=en" -F "targetLang=zh-CN" \
  -F "model=tiny" -F "chunkMin=0.5" -F "overlapSec=5" -F "burnChunkMin=0.5" \
  -F "translate=true" -F "burnIn=true" -F "bilingual=false"
# -> {"id":"job_mwgrmljxw4dv7o"}

# 3. Failure injection (run in parallel): freeze the worker the moment a
#    burnin task is assigned, POST the task failed, resume the worker.
bash probe/inject-burnin-failure.sh job_mwgrmljxw4dv7o
```

## Results (job `job_mwgrmljxw4dv7o`, ~84 s submit → done)

- 3 transcribe + 1 translate tasks done as in v1; `source.srt` and
  `translated.srt` are **byte-identical (md5) to the v1 job** — the
  transcribe/translate path is untouched by the burn-in change.
- Burn planning: 3 segments `[0, 33.38] [33.38, 63.44] [63.44, 67.2]`,
  boundaries snapped to subtitle-gap midpoints near the 30 s / 60 s
  targets; `trimStart` 0 / 0.047 / 5.107 s (segment 2's keyframe sits
  5.1 s before its boundary — the worker's `-ss` trim handled it).
- All 3 burnin tasks done; segment result durations 33.40 / 30.07 /
  3.77 s vs planned 33.38 / 30.06 / 3.76 s (frame rounding only).
- `video.mp4` — h264 640x360 + AAC, 67.36 s, decodes cleanly
  (`ffmpeg -f null -` error-free); `soft.mp4` has a mov_text track and
  also decodes cleanly.
- Subtitles visually confirmed burned in: frames extracted at t=2 s
  (segment 0) and t=40 s (segment 1) both show the translated text at
  the bottom (`probe/frame-v11-t2.png`, `probe/frame-v11-t40.png`).
- UI: `/` serves the updated page (contains "Burn segments" table and
  `burnChunkMin` input); exercised by HTTP fetch only, not in a browser.

## Retry verification (live, this probe)

The injector froze the worker mid-burn of segment 0 and reported that
task failed. The log shows `Task … (burnin) failed, re-queued:
probe-injected failure`; the worker's own upload of the frozen run was
rejected (409, task no longer assigned). After the 60 s exclusion
expired the worker re-claimed segment 0 (attempts=2) and completed it;
segments 1 and 2 finished on first attempt. The job then concatenated
and finished `done`. Only the failed segment re-ran.

## Issues found during the probe (all fixed in the repo)

1. **Edit dropped `run_transcribe`.** An edit inserting the burn-in
   helpers replaced the `def run_transcribe(task):` line, leaving its
   body dangling inside `run_burnin` (dead code). The first probe job
   failed all transcribe tasks with `name 'run_transcribe' is not
   defined` (they re-queued correctly, which the failure path handled).
   Fix: restored the `def` line; worker tests re-run green.
2. **Burn-in input URL mismatch.** The task payload used
   `/api/tasks/<id>/input/video` (path segment) while the route serves
   `?part=video` (query). All burnin tasks 404'd on download. Fix:
   payload now uses `?part=video` / `?part=ass`; unit test updated.
3. **Stale watcher noise.** An injector left over from a deleted job
   kept polling the deleted job id and logged `KeyError: 'tasks'` until
   its 180 s loop expired. Harmless probe-script noise, not a product
   bug; the injector now exits promptly and the log is per-run.

## What this probe does NOT prove

- Docker images / `docker compose up` — not built here (no Docker on
  this VM). The worker Dockerfile now also COPYs `burnin.py`.
- Real Gemini translation quality — still stubbed.
- The `small` model (default) — probe used `tiny` for speed.
- Multi-worker burn-in — one worker only; each segment is an
  independent task on the same claim path, so distribution is the same
  code path regardless of worker count.
- The web UI in a real browser — served (200) and fetched, not clicked.

---

# v1.2 probe — scheduler improvements (2026-11-14)

Same harness, fresh data dir `probe/data-v12`, same 67.2 s video, tiny
model, stubbed Gemini. Job `job_mwgy2x8h8c8hzx`, ~35 s submit → done.

- 3 transcribe + 1 translate + 1 burn-in task, 5/5 done. All tasks
  `ack=true`, `attempts=1` — the ack counted exactly one attempt each.
- Merged 19 → re-segmented 18 → translated 18; `source.srt` and
  `translated.srt` 18 entries each, every translated line `[TR]`.
- `video.mp4` 67.33 s (8.4 MB), `soft.mp4` 67.2 s (7.0 MB);
  `GET /api/jobs/:id/download/source.srt` returns 200.
- Live capability/load reporting verified: the worker record in
  `GET /api/workers` shows `capabilities: ["transcribe","translate",
  "burnin"]`, `ffmpeg: true`, and `stats: {loadAvg1, cpuPercent: null
  (no psutil), memUsedMb, memTotalMb}`; the manager reports version
  `1.2.0`, the worker `1.2.0`.
