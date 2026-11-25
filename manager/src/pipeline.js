// Job pipeline engine: prepares jobs, hands tasks to workers (worker-pull),
// merges results, and synthesizes outputs. The manager never dials workers;
// workers poll for tasks and report results.
//
// Stages: preparing -> transcribing -> merging -> resegmenting ->
//          translating -> synthesizing -> done | failed
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './store.js';
import { planChunks } from './chunkPlan.js';
import { mergeChunks } from './merge.js';
import { toSrt, toAss } from './srt.js';
import { resegmentByWords, llmPolishSegments } from './resegment.js';
import { groupSegments, verifyTranslateResult } from './translate.js';
import { llmConfig, generateText } from './llm.js';
import { planBurnSegments, shiftSegments } from './burnPlan.js';
import { probe, extractAudio, splitAudio, listKeyframes, splitVideo, checkConcatCompatible, concatVideos, muxSoft } from './ffmpeg.js';

export const STALE_ASSIGNED_MS = 15 * 60 * 1000;
// Un-acked assignments are re-offered quickly; the 15-minute stale sweep
// below stays as the backstop for acked-but-silent tasks.
export const ACK_TIMEOUT_MS = 45 * 1000;
export const UNACKED_SWEEP_MS = 10 * 1000;
// A worker that has not heartbeated within this long is presumed dead;
// its assigned tasks are re-queued by verifyAssignedWorkers().
export const WORKER_SILENT_MS = 45 * 1000;
// A failed task prefers another worker, but the exclusion expires after
// this long so a single-worker deployment can still retry it.
export const EXCLUDE_GRACE_MS = 60 * 1000;
// Per-stage retry budgets (total attempts, owned by the pipeline layer —
// the scheduler only records the failure). Translate gets more tries
// because Gemini calls fail transiently more often; burn-in gets one:
// a failed encode is deterministic far more often than transient.
export const RETRY_BUDGET = { transcribe: 2, translate: 3, burnin: 1 };
// Cap on simultaneous in-flight (assigned) tasks across the LAN.
// Overridable with MAX_IN_FLIGHT_TASKS.
export const DEFAULT_MAX_IN_FLIGHT = 16;

const ACTIVE_STAGES = new Set(['preparing', 'transcribing', 'merging', 'resegmenting', 'translating', 'synthesizing']);

export class Runner {
  constructor(store, opts = {}) {
    this.store = store;
    this.llm = llmConfig(opts.env || process.env);
    this.running = new Set();
    const env = opts.env || process.env;
    this.maxInFlight = Number(env.MAX_IN_FLIGHT_TASKS || DEFAULT_MAX_IN_FLIGHT) || DEFAULT_MAX_IN_FLIGHT;
    this.ackTimeoutMs = Number(env.ACK_TIMEOUT_MS || ACK_TIMEOUT_MS) || ACK_TIMEOUT_MS;
  }

  log(job, msg) {
    job.logs = job.logs || [];
    job.logs.push({ ts: new Date().toISOString(), msg });
    if (job.logs.length > 500) job.logs = job.logs.slice(-500);
  }

  fail(job, err) {
    job.stage = 'failed';
    job.error = String(err?.message || err);
    this.log(job, 'FAILED: ' + job.error);
    this.store.saveJob(job);
  }

  // ---- task / scheduler helpers ----
  /** A fresh task. `ack` tracks whether the claiming worker confirmed
   * receipt; `attempts` counts acked runs, not claims. */
  newTask(type, extra = {}) {
    return {
      id: newId('task'),
      type,
      state: 'queued',
      attempts: 0,
      weight: 0,
      queuedAt: new Date().toISOString(),
      ack: false,
      ackDeadline: null,
      workerId: null,
      assignedAt: null,
      excludeWorker: null,
      requeuedAt: null,
      error: null,
      ...extra,
    };
  }

  findTask(taskId) {
    for (const job of this.store.listJobs()) {
      const task = job.tasks.find((t) => t.id === taskId);
      if (task) return { job, task };
    }
    return null;
  }

  /** Total attempts allowed for one task of this type. */
  retryBudgetFor(type) {
    return RETRY_BUDGET[type] ?? 2;
  }

  /** Registry record for a claiming worker, by the id the worker reports
   * (workerId) or the manager-assigned id. Null when unknown. */
  findWorkerForClaim(workerId) {
    if (!workerId) return null;
    const workers = typeof this.store.listWorkers === 'function' ? this.store.listWorkers() : [];
    return workers.find((w) => w.workerId === workerId || w.id === workerId) || null;
  }

  /** Capability check: unknown workers and workers that never reported
   * capabilities are assumed able to do everything (back-compat). */
  workerCanDo(worker, type) {
    if (!worker) return true;
    if (!Array.isArray(worker.capabilities)) return true;
    return worker.capabilities.includes(type);
  }

  /** Whisper model a worker is pinned to (manager-set via the Workers
   * page), or null when unpinned. An unpinned worker takes any job's
   * model; a pinned one only takes tasks whose job asks for its model. */
  workerModelPin(worker) {
    return worker?.modelPin || null;
  }

  /** LLM credentials for a claiming worker: a per-worker override wins
   * per field, everything else falls back to the global server/.env
   * config. An unknown worker (null) resolves to the global config,
   * exactly as before. */
  workerLlm(worker) {
    const override = worker?.llm || null;
    const apiKey = override?.apiKey || this.llm.apiKey;
    const model = override?.model || this.llm.model;
    return { apiKey, model, configured: Boolean(apiKey) };
  }

  /** True when any registered worker carries its own LLM key. */
  anyWorkerHasLlmKey() {
    const workers = typeof this.store.listWorkers === 'function' ? this.store.listWorkers() : [];
    return workers.some((w) => Boolean(w.llm?.apiKey));
  }

  /** Translation can run when a key exists somewhere: the global
   * server/.env key, or any worker's own override key (only workers
   * that resolve a key are offered translate tasks — see claimTask). */
  translationEnabled() {
    return this.llm.configured || this.anyWorkerHasLlmKey();
  }

  /** A job counts as started once any of its tasks is done or assigned. */
  jobStarted(job) {
    return job.tasks.some((t) => t.state === 'done' || t.state === 'assigned');
  }

  /** Effective scheduling weight: base weight + 1 for a started job, so a
   * started job's remaining segments are preferred over a new job. */
  effectiveWeight(job, task) {
    return (task.weight || 0) + (this.jobStarted(job) ? 1 : 0);
  }

  /** Tasks currently out with workers (acked or not). */
  inFlightCount() {
    let n = 0;
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      for (const task of job.tasks) {
        if (task.state === 'assigned') n += 1;
      }
    }
    return n;
  }

  /** Return an assigned task to the queue, or fail it when its per-stage
   * retry budget is spent. Retries go to the back of their weight class. */
  requeueTask(job, task, reason) {
    task.excludeWorker = task.workerId;
    task.workerId = null;
    task.assignedAt = null;
    task.ack = false;
    task.ackDeadline = null;
    const nowIso = new Date().toISOString();
    task.requeuedAt = nowIso;
    task.queuedAt = nowIso;
    if (task.attempts >= this.retryBudgetFor(task.type)) {
      task.state = 'failed';
      task.error = task.error || reason;
      this.log(job, `Task ${task.id} (${task.type}) failed: ${task.error} (attempts exhausted)`);
    } else {
      task.state = 'queued';
      this.log(job, `Task ${task.id} (${task.type}) re-queued: ${reason}`);
    }
  }

  // ---- job creation ----
  buildJobConfig(fields) {
    const config = {
      sourceLang: fields.sourceLang || 'auto',
      targetLang: fields.targetLang || 'zh-CN',
      model: fields.model || 'large-v3',
      chunkMin: Number(fields.chunkMin || 10),
      overlapSec: Number(fields.overlapSec ?? 10),
      burnChunkMin: Number(fields.burnChunkMin || 5),
      translate: fields.translate !== 'false' && fields.translate !== false,
      burnIn: fields.burnIn !== 'false' && fields.burnIn !== false,
      bilingual: fields.bilingual === 'true' || fields.bilingual === true,
    };
    if (!(config.chunkMin >= 0.5 && config.chunkMin <= 120)) throw new Error('chunkMin must be 0.5–120');
    if (!(config.burnChunkMin >= 0.5 && config.burnChunkMin <= 120)) throw new Error('burnChunkMin must be 0.5–120');
    if (!(config.overlapSec >= 0 && config.overlapSec < config.chunkMin * 60)) {
      throw new Error('overlapSec must be >= 0 and < chunk length');
    }
    return config;
  }

  createJob(fields, inputFile) {
    const id = newId('job');
    const config = this.buildJobConfig(fields);
    const job = {
      id,
      name: inputFile.originalName,
      createdAt: new Date().toISOString(),
      config,
      stage: 'preparing',
      duration: 0,
      chunks: [],
      burnSegments: [],
      tasks: [],
      logs: [],
      outputs: {},
      error: null,
    };
    fs.mkdirSync(this.store.jobPath(id, 'input'), { recursive: true });
    fs.mkdirSync(this.store.jobPath(id, 'chunks'), { recursive: true });
    fs.mkdirSync(this.store.jobPath(id, 'results'), { recursive: true });
    const inputPath = this.store.jobPath(id, 'input', inputFile.originalName);
    fs.renameSync(inputFile.path, inputPath);
    job.inputFile = path.join('input', inputFile.originalName);
    this.log(job, `Job created: ${job.name}`);
    this.store.saveJob(job);
    return job;
  }

  // Create a job from a repo video. The job's input is a HARD LINK to
  // the repo file, not a copy: same inode, zero extra disk for even a
  // multi-GB video, and the job keeps working if the repo entry is
  // later deleted (deleting only removes the repo's name; the job's
  // link keeps the data alive). Falls back to a copy when linking is
  // impossible (e.g. repo and job dirs on different filesystems).
  // prepare() and everything downstream work unchanged: they only see
  // job.inputFile, exactly as for an uploaded video.
  createJobFromRepo(fields, repoVideo) {
    const id = newId('job');
    const config = this.buildJobConfig(fields);
    const job = {
      id,
      name: repoVideo.filename,
      createdAt: new Date().toISOString(),
      config,
      stage: 'preparing',
      duration: 0,
      chunks: [],
      burnSegments: [],
      tasks: [],
      logs: [],
      outputs: {},
      error: null,
      repoVideoId: repoVideo.id,
    };
    fs.mkdirSync(this.store.jobPath(id, 'input'), { recursive: true });
    fs.mkdirSync(this.store.jobPath(id, 'chunks'), { recursive: true });
    fs.mkdirSync(this.store.jobPath(id, 'results'), { recursive: true });
    const repoPath = this.store.repoVideoPath(repoVideo);
    if (!fs.existsSync(repoPath)) throw new Error('repo video file missing');
    const inputPath = this.store.jobPath(id, 'input', repoVideo.filename);
    try {
      fs.linkSync(repoPath, inputPath);
    } catch (err) {
      if (err.code === 'EXDEV' || err.code === 'EPERM') {
        fs.copyFileSync(repoPath, inputPath);
      } else {
        throw err;
      }
    }
    job.inputFile = path.join('input', repoVideo.filename);
    this.log(job, `Job created from repo video: ${job.name}`);
    this.store.saveJob(job);
    return job;
  }

  // ---- tick: advance every active job that is not already running ----
  async tick() {
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage) || this.running.has(job.id)) continue;
      this.running.add(job.id);
      try {
        await this.advance(job);
      } catch (err) {
        this.fail(job, err);
      } finally {
        this.running.delete(job.id);
      }
    }
  }

  async advance(job) {
    switch (job.stage) {
      case 'preparing': await this.prepare(job); break;
      case 'transcribing': await this.maybeMerge(job); break;
      case 'merging': await this.merge(job); break;
      case 'resegmenting': await this.resegment(job); break;
      case 'translating': await this.maybeFinishTranslate(job); break;
      case 'synthesizing': await this.synthesize(job); break;
      default: break;
    }
    this.store.saveJob(job);
  }

  async prepare(job) {
    const inputPath = this.store.jobPath(job.id, job.inputFile);
    const info = await probe(inputPath);
    if (!info.hasAudio) throw new Error('input has no audio stream');
    job.duration = info.duration;
    job.hasVideo = info.hasVideo;
    job.videoInfo = {
      fps: info.fps, width: info.width, height: info.height,
      videoCodec: info.videoCodec, audioBitrate: info.audioBitrate,
    };
    this.log(job, `Probed: ${info.duration.toFixed(1)}s, audio=${info.hasAudio}, video=${info.hasVideo}`);
    const wav = this.store.jobPath(job.id, 'audio.wav');
    await extractAudio(inputPath, wav);
    const chunks = planChunks(info.duration, job.config.chunkMin * 60, job.config.overlapSec);
    job.chunks = [];
    for (const c of chunks) {
      const file = this.store.jobPath(job.id, 'chunks', `chunk_${String(c.index).padStart(3, '0')}.wav`);
      await splitAudio(wav, c.start, c.end - c.start, file);
      job.chunks.push({ ...c, file: path.relative(this.store.jobDir(job.id), file), state: 'queued' });
    }
    this.log(job, `Split into ${chunks.length} chunk(s), ${job.config.chunkMin} min + ${job.config.overlapSec}s overlap`);
    job.tasks = chunks.map((c) => this.newTask('transcribe', { chunkIndex: c.index }));
    job.stage = 'transcribing';
  }

  transcribeTasks(job) {
    return job.tasks.filter((t) => t.type === 'transcribe');
  }

  translateTasks(job) {
    return job.tasks.filter((t) => t.type === 'translate');
  }

  async maybeMerge(job) {
    const tasks = this.transcribeTasks(job);
    if (tasks.length === 0) return;
    if (tasks.some((t) => t.state === 'queued' || t.state === 'assigned')) return;
    if (tasks.some((t) => t.state === 'failed')) {
      throw new Error('a transcribe task failed after retries');
    }
    job.stage = 'merging';
    await this.merge(job);
  }

  async merge(job) {
    const chunks = [];
    for (const chunk of job.chunks) {
      const resultFile = this.store.jobPath(job.id, 'results', `transcribe_${chunk.index}.json`);
      const result = this.store.readJson(resultFile, null);
      chunks.push({ offset: chunk.start, segments: result?.segments || [] });
    }
    const merged = mergeChunks(chunks, job.config.overlapSec);
    this.store.writeJsonAtomic(this.store.jobPath(job.id, 'merged.json'), { segments: merged });
    this.log(job, `Merged ${merged.length} segment(s) from ${job.chunks.length} chunk(s)`);
    job.stage = 'resegmenting';
  }

  async resegment(job) {
    const merged = this.store.readJson(this.store.jobPath(job.id, 'merged.json'), { segments: [] });
    let segments = merged.segments || [];
    const hasWords = segments.some((s) => Array.isArray(s.words) && s.words.length > 0);
    if (hasWords) {
      const before = segments.length;
      segments = resegmentByWords(segments);
      this.log(job, `Re-segmented by word timestamps: ${before} -> ${segments.length} segment(s)`);
    } else if (this.llm.configured) {
      const { segments: polished, applied } = await llmPolishSegments(segments, async (texts) => {
        const prompt = [
          'Fix punctuation and casing in these subtitle lines.',
          'Return EXACTLY the same number of lines, in the same order, one per line, no numbering, no extra text.',
          '',
          ...texts,
        ].join('\n');
        const out = await generateText(prompt, this.llm);
        return out.split('\n').map((l) => l.trim()).filter(Boolean);
      });
      segments = polished;
      this.log(job, applied ? 'LLM text polish applied' : 'LLM text polish skipped (count mismatch)');
    } else {
      this.log(job, 'Re-segmentation skipped (no word timestamps, no LLM configured)');
    }
    this.store.writeJsonAtomic(this.store.jobPath(job.id, 'resegmented.json'), { segments });
    fs.writeFileSync(this.store.jobPath(job.id, 'source.srt'), toSrt(segments));
    job.outputs.sourceSrt = 'source.srt';
    if (job.config.translate) {
      // Translation needs a key somewhere: the global server/.env key,
      // or any worker's own override key (only workers that resolve a
      // key are offered translate tasks — see claimTask).
      if (!this.translationEnabled()) {
        this.log(job, 'Translation skipped: no LLM key configured (global or per-worker)');
        job.stage = 'synthesizing';
      } else {
        const groups = groupSegments(segments);
        job.tasks.push(...groups.map((g) => this.newTask('translate', { groupIndex: g.groupIndex })));
        this.log(job, `Created ${groups.length} translate task(s)`);
        job.stage = 'translating';
      }
    } else {
      job.stage = 'synthesizing';
    }
  }

  async maybeFinishTranslate(job) {
    const tasks = this.translateTasks(job);
    if (tasks.length === 0) return;
    if (tasks.some((t) => t.state === 'queued' || t.state === 'assigned')) return;
    if (tasks.some((t) => t.state === 'failed')) {
      throw new Error('a translate task failed after retries');
    }
    const reseg = this.store.readJson(this.store.jobPath(job.id, 'resegmented.json'), { segments: [] });
    const source = reseg.segments || [];
    const translated = new Array(source.length).fill('');
    for (const task of tasks) {
      const result = this.store.readJson(this.store.jobPath(job.id, 'results', `translate_${task.groupIndex}.json`), null);
      if (!result) throw new Error(`missing translate result for group ${task.groupIndex}`);
      for (const line of result.lines) translated[line.index] = line.text;
    }
    if (translated.some((t) => !t)) throw new Error('translated segments incomplete');
    const translatedSegs = source.map((seg, i) => ({ ...seg, text: translated[i] }));
    this.store.writeJsonAtomic(this.store.jobPath(job.id, 'translated.json'), { segments: translatedSegs });
    fs.writeFileSync(this.store.jobPath(job.id, 'translated.srt'), toSrt(translatedSegs));
    job.outputs.translatedSrt = 'translated.srt';
    if (job.config.bilingual) {
      const bilingual = source.map((seg, i) => ({ ...seg, text: `${seg.text}\n${translated[i]}` }));
      fs.writeFileSync(this.store.jobPath(job.id, 'bilingual.srt'), toSrt(bilingual));
      job.outputs.bilingualSrt = 'bilingual.srt';
    }
    this.log(job, `Translated ${translated.length} segment(s)`);
    job.stage = 'synthesizing';
  }

  burninTasks(job) {
    return job.tasks.filter((t) => t.type === 'burnin');
  }

  /** Plan burn segments, cut the video, write per-segment ASS, create tasks. */
  async planBurn(job, mainSegs, inputPath) {
    const plan = planBurnSegments(job.duration, mainSegs, job.config.burnChunkMin * 60);
    const keyframes = await listKeyframes(inputPath);
    const keyframeAtOrBefore = (t) => {
      let at = 0;
      for (const k of keyframes) {
        if (k <= t) at = k;
        else break;
      }
      return at;
    };
    const burnDir = this.store.jobPath(job.id, 'burn');
    fs.mkdirSync(burnDir, { recursive: true });
    const pad = (i) => String(i).padStart(3, '0');
    job.burnSegments = [];
    for (const seg of plan) {
      const actualStart = keyframeAtOrBefore(seg.start);
      const trimStart = Math.round((seg.start - actualStart) * 1000) / 1000;
      const videoFile = path.join('burn', `seg_${pad(seg.index)}.mp4`);
      await splitVideo(inputPath, actualStart, Math.round((seg.end - actualStart) * 1000) / 1000, this.store.jobPath(job.id, videoFile));
      const assFile = path.join('burn', `ass_${pad(seg.index)}.ass`);
      fs.writeFileSync(this.store.jobPath(job.id, assFile), toAss(shiftSegments(seg.subtitles, -seg.start)));
      job.burnSegments.push({
        index: seg.index,
        start: seg.start,
        end: seg.end,
        file: videoFile,
        assFile,
        trimStart,
        duration: Math.round((seg.end - seg.start) * 1000) / 1000,
        state: 'queued',
      });
    }
    job.tasks.push(...plan.map((seg) => this.newTask('burnin', { segmentIndex: seg.index })));
    this.log(job, `Planned ${plan.length} burn-in segment(s), ~${job.config.burnChunkMin} min each`);
  }

  /** Verify burned segments and concatenate them into the final video. */
  async concatBurn(job) {
    const segFiles = job.burnSegments.map((s) =>
      this.store.jobPath(job.id, 'results', `burnin_${s.index}.mp4`));
    await checkConcatCompatible(segFiles, job.videoInfo || null);
    const out = this.store.jobPath(job.id, 'video.mp4');
    await concatVideos(segFiles, out);
    job.outputs.video = 'video.mp4';
    this.log(job, `Burn-in video written: video.mp4 (concatenated from ${segFiles.length} segment(s))`);
  }

  async synthesize(job) {
    const inputPath = this.store.jobPath(job.id, job.inputFile);
    const mainSrt = job.outputs.translatedSrt || job.outputs.sourceSrt;
    const reseg = this.store.readJson(this.store.jobPath(job.id, 'resegmented.json'), { segments: [] });
    let mainSegs = reseg.segments || [];
    if (job.outputs.translatedSrt) {
      mainSegs = this.store.readJson(this.store.jobPath(job.id, 'translated.json'), { segments: [] }).segments || mainSegs;
    }
    if (job.config.bilingual && job.outputs.bilingualSrt) {
      const source = reseg.segments || [];
      const translated = this.store.readJson(this.store.jobPath(job.id, 'translated.json'), { segments: [] }).segments || [];
      mainSegs = source.map((seg, i) => ({ ...seg, text: `${seg.text}\n${translated[i]?.text || ''}` }));
    }
    if (job.config.burnIn) {
      if (!job.hasVideo) throw new Error('burn-in requires a video stream (input has audio only)');
      if (!job.burnSegments || job.burnSegments.length === 0) {
        await this.planBurn(job, mainSegs, inputPath);
        return; // wait for workers to burn the segments
      }
      const tasks = this.burninTasks(job);
      if (tasks.some((t) => t.state === 'queued' || t.state === 'assigned')) return;
      if (tasks.some((t) => t.state === 'failed')) {
        throw new Error('a burn-in task failed after retries');
      }
      await this.concatBurn(job);
    }
    const softOut = this.store.jobPath(job.id, 'soft.mp4');
    const srtPath = this.store.jobPath(job.id, mainSrt);
    await muxSoft(inputPath, srtPath, softOut, job.config.targetLang.split('-')[0] || 'und');
    job.outputs.softVideo = 'soft.mp4';
    this.log(job, 'Soft-sub video written: soft.mp4');
    job.stage = 'done';
  }

  // ---- task claiming / results (worker-pull) ----
  // Offers the best queued task of the requested type to this worker:
  // only tasks the worker is capable of, below the in-flight cap,
  // ordered by effective weight DESC, then queuedAt ASC.
  // Claiming reserves the task but does NOT count an attempt — the
  // attempt is counted when the worker acks receipt (see ackTask).
  claimTask(type, workerId) {
    const now = Date.now();
    const worker = this.findWorkerForClaim(workerId);
    if (!this.workerCanDo(worker, type)) return null;
    // Translate tasks are only offered to a worker that can resolve an
    // LLM key (own override, else the global one). Without this a
    // keyless worker would claim the task and burn its retry budget;
    // the task simply waits for a capable worker instead.
    if (type === 'translate' && !this.workerLlm(worker).configured) return null;
    if (this.inFlightCount() >= this.maxInFlight) return null;
    // A model-pinned worker only takes transcribe tasks whose job asks
    // for that model. The pin is a capability constraint, not a
    // rewrite — the job's model choice is never overridden.
    const pin = type === 'transcribe' ? this.workerModelPin(worker) : null;
    const candidates = [];
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      for (const task of job.tasks) {
        if (task.type !== type || task.state !== 'queued') continue;
        // A failed task prefers another worker, but the exclusion expires
        // after EXCLUDE_GRACE_MS so a single-worker deployment can retry.
        if (task.excludeWorker === workerId &&
            !(task.requeuedAt && now - new Date(task.requeuedAt).getTime() > EXCLUDE_GRACE_MS)) continue;
        if (pin && (job.config.model || 'large-v3') !== pin) continue;
        candidates.push({ job, task, weight: this.effectiveWeight(job, task) });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) =>
      (b.weight - a.weight) ||
      (new Date(a.task.queuedAt || a.job.createdAt) - new Date(b.task.queuedAt || b.job.createdAt)) ||
      String(a.job.createdAt || '').localeCompare(String(b.job.createdAt || '')));
    const { job, task } = candidates[0];
    task.state = 'assigned';
    task.workerId = workerId;
    task.assignedAt = new Date().toISOString();
    task.ack = false;
    task.ackDeadline = new Date(now + this.ackTimeoutMs).toISOString();
    this.store.saveJob(job);
    return { job, task };
  }

  /** The claiming worker confirms receipt. Idempotent: a second ack for
   * the same assignment does not count another attempt. Throws with
   * err.status 409 (not assigned) or 403 (another worker's task). */
  ackTask(job, task, workerId) {
    if (task.state !== 'assigned') {
      const err = new Error('task is not assigned');
      err.status = 409;
      throw err;
    }
    if (task.workerId !== workerId) {
      const err = new Error('task is assigned to another worker');
      err.status = 403;
      throw err;
    }
    if (!task.ack) {
      task.ack = true;
      task.attempts += 1;
      this.store.saveJob(job);
    }
    return { job, task };
  }

  taskInput(job, task) {
    if (task.type === 'transcribe') {
      const chunk = job.chunks[task.chunkIndex];
      return { kind: 'file', path: this.store.jobPath(job.id, chunk.file), filename: path.basename(chunk.file) };
    }
    if (task.type === 'burnin') {
      // JSON payload: the worker downloads the segment video + ASS itself.
      const seg = job.burnSegments[task.segmentIndex];
      const v = job.videoInfo || {};
      return {
        kind: 'json',
        payload: {
          taskId: task.id,
          type: 'burnin',
          videoUrl: `/api/tasks/${task.id}/input?part=video`,
          assUrl: `/api/tasks/${task.id}/input?part=ass`,
          trimStart: seg.trimStart,
          duration: seg.duration,
          crf: 20,
          fps: v.fps ?? null,
          width: v.width ?? null,
          height: v.height ?? null,
          videoCodec: v.videoCodec ?? null,
          audioBitrate: v.audioBitrate ?? null,
        },
      };
    }
    // translate: JSON payload (segments + LLM credentials for the worker).
    // Credentials resolve per claiming worker: a per-worker override wins
    // per field, otherwise the global server/.env config. task.workerId
    // is set at claim time, so this also holds for the input fetch.
    const reseg = this.store.readJson(this.store.jobPath(job.id, 'resegmented.json'), { segments: [] });
    const groups = groupSegments(reseg.segments || []);
    const group = groups[task.groupIndex];
    const llm = this.workerLlm(this.findWorkerForClaim(task.workerId));
    return {
      kind: 'json',
      payload: {
        taskId: task.id,
        type: 'translate',
        sourceLang: job.config.sourceLang,
        targetLang: job.config.targetLang,
        segments: group.segments,
        llmApiKey: llm.apiKey,
        llmModel: llm.model,
      },
    };
  }

  completeTask(job, task, { status, result, error }) {
    if (status === 'done') {
      if (task.type === 'transcribe') {
        if (!result || !Array.isArray(result.segments)) throw new Error('bad transcribe result: missing segments');
        this.store.writeJsonAtomic(
          this.store.jobPath(job.id, 'results', `transcribe_${task.chunkIndex}.json`),
          { segments: result.segments },
        );
        const chunk = job.chunks[task.chunkIndex];
        if (chunk) chunk.state = 'done';
      } else if (task.type === 'burnin') {
        if (!result || !result.file) throw new Error('bad burn-in result: missing file');
        const resultPath = this.store.jobPath(job.id, 'results', `burnin_${task.segmentIndex}.mp4`);
        if (!fs.existsSync(resultPath)) throw new Error('bad burn-in result: file missing');
        const seg = job.burnSegments[task.segmentIndex];
        if (seg) seg.state = 'done';
      } else {
        if (!result || !Array.isArray(result.lines)) throw new Error('bad translate result: missing lines');
        const reseg = this.store.readJson(this.store.jobPath(job.id, 'resegmented.json'), { segments: [] });
        const groups = groupSegments(reseg.segments || []);
        const check = verifyTranslateResult(groups[task.groupIndex], result.lines.map((l) => l.text));
        if (!check.ok) throw new Error('translate result rejected: ' + check.error);
        this.store.writeJsonAtomic(
          this.store.jobPath(job.id, 'results', `translate_${task.groupIndex}.json`),
          { lines: result.lines },
        );
      }
      task.state = 'done';
      task.error = null;
      this.log(job, `Task ${task.id} (${task.type}) done by ${task.workerId}`);
    } else {
      task.error = String(error || 'worker reported failure');
      this.requeueTask(job, task, 'worker failure');
    }
    this.store.saveJob(job);
  }

  /** Re-queue assignments that have been silent too long (backstop for
   * acked-but-silent tasks; the fast paths are sweepUnacked and
   * verifyAssignedWorkers). */
  sweepStale(nowMs = Date.now()) {
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      let changed = false;
      for (const task of job.tasks) {
        if (task.state !== 'assigned' || !task.assignedAt) continue;
        if (nowMs - new Date(task.assignedAt).getTime() > STALE_ASSIGNED_MS) {
          task.error = 'timed out';
          this.requeueTask(job, task, 'timed out');
          changed = true;
        }
      }
      if (changed) this.store.saveJob(job);
    }
  }

  /** Re-offer assignments whose worker never acked receipt. An un-acked
   * assignment never consumed an attempt, so it always re-queues. Runs on
   * a short loop (UNACKED_SWEEP_MS); returns how many were re-offered. */
  sweepUnacked(nowMs = Date.now()) {
    let requeued = 0;
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      let changed = false;
      for (const task of job.tasks) {
        if (task.state !== 'assigned' || task.ack) continue;
        const deadline = task.ackDeadline
          ? new Date(task.ackDeadline).getTime()
          : (task.assignedAt ? new Date(task.assignedAt).getTime() + this.ackTimeoutMs : 0);
        if (nowMs <= deadline) continue;
        this.requeueTask(job, task, 'ack timeout');
        changed = true;
        requeued += 1;
      }
      if (changed) this.store.saveJob(job);
    }
    return requeued;
  }

  /** Re-queue the in-flight tasks of one worker. Used when a worker
   * restarts under the same stable id (new bootId): the old
   * incarnation is dead even though the worker row stays online —
   * the new incarnation keeps heartbeating — so waiting for the
   * 15-minute sweepStale backstop would strand its work. The
   * re-queued task excludes the worker for the usual grace period,
   * exactly like a 'worker silent' re-queue. */
  requeueWorkerTasks(workerId, reason = 'worker restarted') {
    let requeued = 0;
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      let changed = false;
      for (const task of job.tasks) {
        if (task.state !== 'assigned' || task.workerId !== workerId) continue;
        task.error = reason;
        this.requeueTask(job, task, reason);
        changed = true;
        requeued += 1;
      }
      if (changed) this.store.saveJob(job);
    }
    return requeued;
  }

  /** Re-queue tasks assigned to workers that stopped heartbeating, and
   * mark those workers offline. A live worker heartbeats every 15 s even
   * while a task is running, so a silent worker is presumed dead.
   * Returns how many tasks were re-queued. */
  verifyAssignedWorkers(nowMs = Date.now()) {
    const workers = typeof this.store.listWorkers === 'function' ? this.store.listWorkers() : [];
    const byId = new Map();
    for (const w of workers) {
      if (w.workerId) byId.set(w.workerId, w);
      byId.set(w.id, w);
    }
    let requeued = 0;
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      let changed = false;
      for (const task of job.tasks) {
        if (task.state !== 'assigned' || !task.workerId) continue;
        const worker = byId.get(task.workerId);
        const lastSeen = worker?.lastSeen ? new Date(worker.lastSeen).getTime() : 0;
        if (worker && nowMs - lastSeen <= WORKER_SILENT_MS) continue;
        task.error = 'worker silent';
        this.requeueTask(job, task, 'worker silent');
        changed = true;
        requeued += 1;
      }
      if (changed) this.store.saveJob(job);
    }
    let workersChanged = false;
    for (const w of workers) {
      if (w.status === 'online' && w.lastSeen &&
          nowMs - new Date(w.lastSeen).getTime() > WORKER_SILENT_MS) {
        w.status = 'offline';
        workersChanged = true;
      }
    }
    if (workersChanged) this.store.saveWorkers(workers);
    return requeued;
  }

  /** Run at manager startup: sweep stale assignments now, so tasks
   * orphaned by a manager restart are not stuck until the periodic
   * sweep. The heartbeat-liveness pass runs shortly after boot (the
   * server schedules verifyAssignedWorkers) once live workers have had
   * a chance to re-heartbeat. */
  reconcileOnBoot() {
    this.sweepStale();
  }
}
