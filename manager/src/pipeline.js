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
export const MAX_ATTEMPTS = 2; // first try + one retry

const ACTIVE_STAGES = new Set(['preparing', 'transcribing', 'merging', 'resegmenting', 'translating', 'synthesizing']);

export class Runner {
  constructor(store, opts = {}) {
    this.store = store;
    this.llm = llmConfig(opts.env || process.env);
    this.running = new Set();
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

  // ---- job creation ----
  createJob(fields, inputFile) {
    const id = newId('job');
    const config = {
      sourceLang: fields.sourceLang || 'auto',
      targetLang: fields.targetLang || 'zh-CN',
      model: fields.model || 'small',
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
    job.tasks = chunks.map((c) => ({
      id: newId('task'),
      type: 'transcribe',
      chunkIndex: c.index,
      state: 'queued',
      attempts: 0,
      workerId: null,
      assignedAt: null,
      excludeWorker: null,
      error: null,
    }));
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
      if (!this.llm.configured) {
        this.log(job, 'Translation skipped: LLM_API_KEY is not configured');
        job.stage = 'synthesizing';
      } else {
        const groups = groupSegments(segments);
        job.tasks.push(...groups.map((g) => ({
          id: newId('task'),
          type: 'translate',
          groupIndex: g.groupIndex,
          state: 'queued',
          attempts: 0,
          workerId: null,
          assignedAt: null,
          excludeWorker: null,
          error: null,
        })));
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
    job.tasks.push(...plan.map((seg) => ({
      id: newId('task'),
      type: 'burnin',
      segmentIndex: seg.index,
      state: 'queued',
      attempts: 0,
      workerId: null,
      assignedAt: null,
      excludeWorker: null,
      error: null,
    })));
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
  claimTask(type, workerId) {
    const now = Date.now();
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      // A failed task prefers another worker, but the exclusion expires
      // after 60s so a single-worker deployment can still retry it.
      const tasks = job.tasks.filter((t) => {
        if (t.type !== type || t.state !== 'queued') return false;
        if (t.excludeWorker !== workerId) return true;
        return t.requeuedAt && now - new Date(t.requeuedAt).getTime() > 60000;
      });
      if (tasks.length === 0) continue;
      const task = tasks[0];
      task.state = 'assigned';
      task.workerId = workerId;
      task.assignedAt = new Date().toISOString();
      task.attempts += 1;
      this.store.saveJob(job);
      return { job, task };
    }
    return null;
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
    const reseg = this.store.readJson(this.store.jobPath(job.id, 'resegmented.json'), { segments: [] });
    const groups = groupSegments(reseg.segments || []);
    const group = groups[task.groupIndex];
    return {
      kind: 'json',
      payload: {
        taskId: task.id,
        type: 'translate',
        sourceLang: job.config.sourceLang,
        targetLang: job.config.targetLang,
        segments: group.segments,
        llmApiKey: this.llm.apiKey,
        llmModel: this.llm.model,
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
      if (task.attempts >= MAX_ATTEMPTS) {
        task.state = 'failed';
        this.log(job, `Task ${task.id} (${task.type}) failed permanently: ${task.error}`);
      } else {
        task.state = 'queued';
        task.excludeWorker = task.workerId; // retry on another worker
        task.workerId = null;
        task.assignedAt = null;
        task.requeuedAt = new Date().toISOString();
        this.log(job, `Task ${task.id} (${task.type}) failed, re-queued: ${task.error}`);
      }
    }
    this.store.saveJob(job);
  }

  /** Re-queue assignments that have been silent too long. */
  sweepStale() {
    const now = Date.now();
    for (const job of this.store.listJobs()) {
      if (!ACTIVE_STAGES.has(job.stage)) continue;
      let changed = false;
      for (const task of job.tasks) {
        if (task.state !== 'assigned' || !task.assignedAt) continue;
        if (now - new Date(task.assignedAt).getTime() > STALE_ASSIGNED_MS) {
          task.excludeWorker = task.workerId;
          task.workerId = null;
          task.assignedAt = null;
          task.requeuedAt = new Date().toISOString();
          if (task.attempts >= MAX_ATTEMPTS) {
            task.state = 'failed';
            task.error = 'timed out';
          } else {
            task.state = 'queued';
          }
          this.log(job, `Task ${task.id} timed out, re-queued`);
          changed = true;
        }
      }
      if (changed) this.store.saveJob(job);
    }
  }
}
