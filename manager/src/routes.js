// REST API for Lantern manager.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { parseMultipart } from './multipart.js';
import { newId } from './store.js';
import { getJobType, listJobTypes, TRANSCRIPTION_ENGINES, DEFAULT_ENGINE } from './jobTypes.js';

const DOWNLOADABLE = {
  'source.srt': (job) => job.outputs.sourceSrt,
  'translated.srt': (job) => job.outputs.translatedSrt,
  'bilingual.srt': (job) => job.outputs.bilingualSrt,
  'video.mp4': (job) => job.outputs.video,
  'soft.mp4': (job) => job.outputs.softVideo,
};

// Display/download filename: no path separators, quotes or control
// characters, so it is safe in metadata and Content-Disposition.
function sanitizeFilename(name) {
  return String(name || '').replace(/[\\/]/g, '_').replace(/["\r\n\x00-\x1f\x7f]/g, '').trim() || 'video';
}

// Parse a single-part HTTP Range header. Returns { start, end }
// (inclusive) or null when malformed or unsatisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  let start;
  let end;
  if (startStr === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endStr);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export function createRouter(store, runner) {
  const router = express.Router();

  const findTask = (taskId) => runner.findTask(taskId);

  // The Whisper models a worker can be pinned to: the same list the job
  // form offers, so a pin can never name a model no job uses.
  const VALID_MODELS = (() => {
    const type = getJobType('video-translation');
    const field = type?.fields?.find((f) => f.key === 'model');
    return new Set((field?.options || []).map((o) => o.value));
  })();

  // The transcription engines a worker can be pinned to: same pattern.
  const VALID_ENGINES = new Set(TRANSCRIPTION_ENGINES.map((e) => e.value));

  // A worker record as the API may return it: the per-worker LLM key is
  // NEVER sent back — only whether one is set, which model the override
  // uses, and a last-4 hint so the UI can show what is stored.
  const publicWorker = (w) => {
    const { llm, ...rest } = w || {};
    const pub = { ...rest, currentTask: currentTaskForWorker(w) };
    pub.llm = !llm ? null : {
      configured: Boolean(llm.apiKey),
      model: llm.model || null,
      keyHint: llm.apiKey ? `••••${String(llm.apiKey).slice(-4)}` : null,
    };
    return pub;
  };

  // Heartbeat models report, validated lightly: { loaded, available[] }.
  const sanitizeModels = (models) => {
    if (!models || typeof models !== 'object') return null;
    return {
      loaded: typeof models.loaded === 'string' ? models.loaded : null,
      available: Array.isArray(models.available)
        ? models.available.filter((m) => typeof m === 'string')
        : [],
    };
  };

  // The task a worker is currently running, if any: tasks carry the
  // worker's id once assigned, so the Workers page can show what each
  // worker is doing without a second fetch. Matches on either the
  // worker-reported id or the manager-generated registry id.
  const currentTaskForWorker = (worker) => {
    const ids = [worker.workerId, worker.id].filter(Boolean);
    for (const job of store.listJobs()) {
      for (const task of job.tasks || []) {
        if (task.state === 'assigned' && ids.includes(task.workerId)) {
          return {
            jobId: job.id,
            jobName: job.name,
            taskId: task.id,
            type: task.type,
            chunkIndex: task.chunkIndex ?? null,
            groupIndex: task.groupIndex ?? null,
            segmentIndex: task.segmentIndex ?? null,
          };
        }
      }
    }
    return null;
  };

  router.get('/health', (req, res) => res.json({ ok: true, version: '1.4.0' }));

  // Job-type registry: the UI renders the "new job" form from this
  // schema, so a new type is a registry entry, not a UI change.
  router.get('/job-types', (req, res) => res.json(listJobTypes()));

  // ---- jobs ----
  router.get('/jobs', (req, res) => {
    const jobs = store.listJobs().map((j) => ({
      id: j.id,
      name: j.name,
      jobType: j.jobType || 'video-translation',
      createdAt: j.createdAt,
      stage: j.stage,
      duration: j.duration,
      config: j.config,
      error: j.error,
      tasksTotal: j.tasks.length,
      tasksDone: j.tasks.filter((t) => t.state === 'done').length,
      tasksFailed: j.tasks.filter((t) => t.state === 'failed').length,
      outputs: j.outputs,
    }));
    res.json(jobs);
  });

  router.post('/jobs', async (req, res) => {
    try {
      const ct = req.headers['content-type'] || '';
      const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!m) return res.status(400).json({ error: 'expected multipart/form-data' });
      const boundary = (m[1] || m[2]).trim();
      const uploadDir = path.join(store.dataDir, 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      const { fields, files } = await parseMultipart(req, boundary, (fieldname, filename) => {
        const tmp = path.join(uploadDir, `${newId('up')}_${filename}`);
        return tmp;
      });
      // Job type is optional for backward compatibility: an upload with
      // no jobType is a video-translation job, as before.
      const jobType = fields.jobType || 'video-translation';
      const type = getJobType(jobType);
      if (!type) return res.status(400).json({ error: `unknown job type: ${jobType}` });
      // Source: either an uploaded file (as before) or a repo video
      // (fields.repoVideoId). Exactly one of the two.
      const repoVideoId = fields.repoVideoId || null;
      let job;
      if (repoVideoId) {
        if (files.length > 0) {
          for (const f of files) fs.rmSync(f.path, { force: true });
          return res.status(400).json({ error: 'provide either a file upload or repoVideoId, not both' });
        }
        const repoVideo = store.getRepoVideo(repoVideoId);
        if (!repoVideo) return res.status(404).json({ error: 'repo video not found' });
        job = runner.createJobFromRepo(fields, repoVideo);
      } else {
        for (const field of type.fields) {
          if (field.kind === 'file' && field.required && !files.find((f) => f.fieldname === field.key)) {
            return res.status(400).json({ error: `missing ${field.label.toLowerCase()} file (field "${field.key}")` });
          }
        }
        const fileField = type.fields.find((f) => f.kind === 'file');
        const video = fileField && files.find((f) => f.fieldname === fileField.key);
        if (!video) return res.status(400).json({ error: `missing ${fileField.label.toLowerCase()} file (field "${fileField.key}")` });
        job = runner.createJob(fields, { path: video.path, originalName: video.filename || 'video.mp4' });
      }
      job.jobType = jobType;
      if (store.saveJob) store.saveJob(job);
      runner.tick().catch(() => {});
      res.status(201).json({ id: job.id });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  router.get('/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  });

  router.delete('/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    store.deleteJob(req.params.id);
    res.json({ ok: true });
  });

  router.get('/jobs/:id/download/:name', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const { name } = req.params;
    let rel = null;
    if (name === 'input') rel = job.inputFile;
    else if (DOWNLOADABLE[name]) rel = DOWNLOADABLE[name](job);
    if (!rel) return res.status(404).json({ error: 'output not available' });
    const file = store.jobPath(job.id, rel);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'file missing' });
    res.download(file, name);
  });

  // ---- repo (LAN video library) ----
  // Plain HTTP, no auth — the same LAN-trust model as the rest of the
  // API, so workers can pull videos directly with a single GET.
  router.get('/repo/videos', (req, res) => {
    res.json(store.listRepoVideos());
  });

  // Upload a video into the repo. The file part streams to disk (see
  // multipart.js) — a multi-GB video is never buffered in memory.
  router.post('/repo/videos', async (req, res) => {
    const ct = req.headers['content-type'] || '';
    const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!m) return res.status(400).json({ error: 'expected multipart/form-data' });
    const boundary = (m[1] || m[2]).trim();
    const id = newId('video');
    const tmpPath = path.join(store.repoDir, `${id}.tmp`);
    try {
      const { files } = await parseMultipart(req, boundary, (fieldname) => {
        if (fieldname !== 'file') throw new Error('unexpected file field: ' + fieldname);
        return tmpPath;
      });
      const file = files[0];
      if (files.length !== 1 || !file || file.size === 0) {
        fs.rmSync(tmpPath, { force: true });
        return res.status(400).json({ error: 'missing video file (field "file")' });
      }
      // Keep the original extension on disk so the repo dir stays
      // browsable; the record is the source of truth for the name.
      const ext = (/(\.[A-Za-z0-9]+)$/.exec(file.filename || '') || [])[1] || '';
      const storedName = `${id}${ext}`;
      fs.renameSync(tmpPath, path.join(store.repoDir, storedName));
      const video = {
        id,
        filename: sanitizeFilename(file.filename || storedName),
        storedName,
        size: file.size,
        uploadedAt: new Date().toISOString(),
      };
      store.addRepoVideo(video);
      res.status(201).json(video);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  // Download a repo video. Supports HTTP Range (bytes=start-end,
  // bytes=start-, bytes=-suffix) so a worker can resume a large
  // download instead of restarting it.
  router.get('/repo/videos/:id', (req, res) => {
    const video = store.getRepoVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'repo video not found' });
    const file = store.repoVideoPath(video);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'file missing' });
    const size = fs.statSync(file).size;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${sanitizeFilename(video.filename)}"`,
      'Accept-Ranges': 'bytes',
    };
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
      return;
    }
    const parsed = parseRange(range, size);
    if (!parsed) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const { start, end } = parsed;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });

  router.delete('/repo/videos/:id', (req, res) => {
    const video = store.removeRepoVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'repo video not found' });
    // Jobs created from this video keep working: their input is a hard
    // link to the same inode, so removing the repo's name does not
    // free the data.
    fs.rmSync(store.repoVideoPath(video), { force: true });
    res.json({ ok: true });
  });

  // ---- workers ----
  router.get('/workers', (req, res) => res.json(store.listWorkers().map((w) => publicWorker(w))));

  router.post('/workers', (req, res) => {
    const { host, port, name } = req.body || {};
    if (!host || !port) return res.status(400).json({ error: 'host and port are required' });
    const workers = store.listWorkers();
    const existing = workers.find((w) => w.host === host && Number(w.port) === Number(port));
    if (existing) return res.json(existing);
    const worker = {
      id: newId('worker'),
      name: name || `${host}:${port}`,
      host,
      port: Number(port),
      status: 'offline',
      registered: true,
      lastSeen: null,
      load: null,
      model: null,
      modelPin: null,
      enginePin: null,
      llm: null,
      models: null,
      version: null,
      createdAt: new Date().toISOString(),
    };
    workers.push(worker);
    store.saveWorkers(workers);
    res.status(201).json(publicWorker(worker));
  });

  router.delete('/workers/:id', (req, res) => {
    const workers = store.listWorkers().filter((w) => w.id !== req.params.id);
    store.saveWorkers(workers);
    res.json({ ok: true });
  });

  // Per-worker settings, set from the master: a Whisper model pin, a
  // transcription engine pin, and an LLM override. All live on the worker
  // record in workers.json and take effect for tasks claimed afterwards;
  // a task already in flight keeps the settings it claimed with.
  //   { modelPin?: string|null, enginePin?: string|null, llm?: { apiKey?: string, model?: string } | null }
  // modelPin: null/'' clears the pin; any other value must be a model
  //   the job form offers (400 otherwise). Absent = unchanged.
  // enginePin: same, against the engine list; a pinned worker only takes
  //   transcribe tasks whose job asks for its engine.
  // llm: null clears the override. An object applies per field:
  //   apiKey present -> replace ('' clears the key), absent -> keep;
  //   model present -> replace ('' = fall back to the global model),
  //   absent -> keep. An override with neither field set is stored as
  //   null (no override). The key is never returned: see publicWorker.
  router.post('/workers/:id/settings', (req, res) => {
    const workers = store.listWorkers();
    const worker = workers.find((w) => w.id === req.params.id);
    if (!worker) return res.status(404).json({ error: 'worker not found' });
    const body = req.body || {};
    if ('modelPin' in body) {
      const pin = body.modelPin;
      if (pin === null || pin === '') worker.modelPin = null;
      else if (typeof pin === 'string' && VALID_MODELS.has(pin)) worker.modelPin = pin;
      else return res.status(400).json({ error: `unknown model: ${String(pin)}` });
    }
    if ('enginePin' in body) {
      const pin = body.enginePin;
      if (pin === null || pin === '') worker.enginePin = null;
      else if (typeof pin === 'string' && VALID_ENGINES.has(pin)) worker.enginePin = pin;
      else return res.status(400).json({ error: `unknown transcription engine: ${String(pin)}` });
    }
    if ('llm' in body) {
      const llm = body.llm;
      if (llm === null) {
        worker.llm = null;
      } else if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
        const next = { ...(worker.llm || { apiKey: null, model: null }) };
        if ('apiKey' in llm) {
          if (typeof llm.apiKey !== 'string') return res.status(400).json({ error: 'llm.apiKey must be a string' });
          next.apiKey = llm.apiKey || null;
        }
        if ('model' in llm) {
          if (typeof llm.model !== 'string') return res.status(400).json({ error: 'llm.model must be a string' });
          next.model = llm.model || null;
        }
        worker.llm = (next.apiKey || next.model) ? next : null;
      } else {
        return res.status(400).json({ error: 'llm must be an object or null' });
      }
    }
    store.saveWorkers(workers);
    res.json(publicWorker(worker));
  });

  router.post('/workers/heartbeat', (req, res) => {
    const { id, bootId, host, port, name, load, model, models, engines, version, capabilities, ffmpeg, stats } = req.body || {};
    if (!host || !port) return res.status(400).json({ error: 'host and port are required' });
    const workers = store.listWorkers();
    // Match on the worker-reported stable id first: the same machine
    // heartbeats under a new container hostname after every redeploy,
    // so matching on host:port alone would register a duplicate row.
    // The host:port fallback keeps pre-registered rows (POST /workers)
    // and legacy workers that report no stable id merging correctly.
    let worker = (id && workers.find((w) => w.workerId === id || w.id === id)) ||
      workers.find((w) => w.host === host && Number(w.port) === Number(port));
    if (!worker) {
      worker = {
        id: newId('worker'),
        workerId: id || null,
        bootId: bootId || null,
        name: name || `${host}:${port}`,
        host,
        port: Number(port),
        status: 'online',
        registered: false,
        lastSeen: new Date().toISOString(),
        load: load ?? null,
        model: model || null,
        modelPin: null,
        enginePin: null,
        llm: null,
        models: sanitizeModels(models),
        engines: Array.isArray(engines) ? engines.filter((e) => VALID_ENGINES.has(e)) : null,
        version: version || null,
        capabilities: Array.isArray(capabilities) ? capabilities : null,
        ffmpeg: ffmpeg ?? null,
        stats: stats ?? null,
        createdAt: new Date().toISOString(),
      };
      workers.push(worker);
    } else {
      // A different bootId under the same stable id means the previous
      // incarnation died (e.g. container recreated on deploy) while the
      // row stays online: re-offer its in-flight tasks now instead of
      // waiting for the 15-minute stale sweep.
      const restarted = Boolean(bootId && worker.bootId && worker.bootId !== bootId);
      worker.status = 'online';
      worker.lastSeen = new Date().toISOString();
      worker.host = host;
      worker.port = Number(port);
      if (bootId) worker.bootId = bootId;
      if (id && !worker.workerId) worker.workerId = id;
      if (load !== undefined) worker.load = load;
      if (model) worker.model = model;
      // Only overwrite the models report when the worker sent one:
      // pre-1.3 workers never send it, and their last report stays.
      if (models !== undefined) worker.models = sanitizeModels(models);
      // Same for the engines report (pre-1.4 workers never send one).
      if (engines !== undefined) {
        worker.engines = Array.isArray(engines) ? engines.filter((e) => VALID_ENGINES.has(e)) : null;
      }
      if (version) worker.version = version;
      if (name) worker.name = name;
      if (Array.isArray(capabilities)) worker.capabilities = capabilities;
      if (ffmpeg !== undefined) worker.ffmpeg = ffmpeg;
      if (stats !== undefined) worker.stats = stats;
      if (restarted && typeof runner.requeueWorkerTasks === 'function') {
        runner.requeueWorkerTasks(worker.workerId || id, 'worker restarted');
      }
    }
    store.saveWorkers(workers);
    res.json({ id: worker.id, registered: worker.registered });
  });

  // ---- tasks (worker-pull) ----
  router.get('/tasks/next', (req, res) => {
    const { type, workerId } = req.query;
    if (type !== 'transcribe' && type !== 'translate' && type !== 'burnin' && type !== 'final-burnin') {
      return res.status(400).json({ error: 'type must be transcribe, translate, burnin or final-burnin' });
    }
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    const claimed = runner.claimTask(type, String(workerId));
    if (!claimed) return res.status(204).end();
    const { job, task } = claimed;
    const input = runner.taskInput(job, task);
    res.json({
      taskId: task.id,
      jobId: job.id,
      type: task.type,
      chunkIndex: task.chunkIndex ?? null,
      groupIndex: task.groupIndex ?? null,
      segmentIndex: task.segmentIndex ?? null,
      model: job.config.model,
      engine: job.config.engine || DEFAULT_ENGINE,
      sourceLang: job.config.sourceLang === 'auto' ? null : job.config.sourceLang,
      inputUrl: `/api/tasks/${task.id}/input`,
      inputKind: input.kind,
    });
  });

  // The claiming worker confirms receipt right after claiming. A task
  // that is never acked is re-offered by the un-acked sweep; the ack
  // counts the attempt (see Runner.ackTask).
  router.post('/tasks/:id/ack', (req, res) => {
    const found = findTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'task not found' });
    const { workerId } = req.body || {};
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    try {
      runner.ackTask(found.job, found.task, workerId);
    } catch (err) {
      return res.status(err.status || 400).json({ error: String(err?.message || err) });
    }
    res.json({ ok: true });
  });

  router.get('/tasks/:id/input', (req, res) => {
    const found = findTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'task not found' });
    const { job, task } = found;
    if (task.state !== 'assigned') return res.status(409).json({ error: 'task is not assigned' });
    const input = runner.taskInput(job, task);
    if (input.kind === 'file') {
      if (!fs.existsSync(input.path)) return res.status(404).json({ error: 'task file missing' });
      res.download(input.path, input.filename);
    } else if ((task.type === 'burnin' || task.type === 'final-burnin') && req.query.part) {
      // Burn-in tasks fetch their two inputs separately. Segmented
      // burn-in gets its cut segment + per-segment ASS; final burn-in
      // gets the ORIGINAL video + the total ASS.
      let rel = null;
      if (task.type === 'burnin') {
        const seg = job.burnSegments[task.segmentIndex];
        rel = req.query.part === 'video' ? seg?.file : req.query.part === 'ass' ? seg?.assFile : null;
      } else {
        rel = req.query.part === 'video' ? job.inputFile : req.query.part === 'ass' ? job.finalAssFile : null;
      }
      if (!rel) return res.status(400).json({ error: 'part must be video or ass' });
      const file = store.jobPath(job.id, rel);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'task file missing' });
      res.download(file, path.basename(file));
    } else {
      res.json(input.payload);
    }
  });

  router.post('/tasks/:id/result', (req, res) => {
    const found = findTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'task not found' });
    const { job, task } = found;
    if (task.state !== 'assigned') return res.status(409).json({ error: 'task is not assigned' });
    const { workerId, status, result, error } = req.body || {};
    if (workerId && task.workerId && workerId !== task.workerId) {
      return res.status(403).json({ error: 'task is assigned to another worker' });
    }
    if (status !== 'done' && status !== 'failed') {
      return res.status(400).json({ error: 'status must be done or failed' });
    }
    try {
      runner.completeTask(job, task, { status, result, error });
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }
    runner.tick().catch(() => {});
    res.json({ ok: true });
  });

  // Burn-in result upload: the encoded video is a file, too large for the
  // JSON result endpoint. The worker posts multipart form-data with the file
  // in field "file" plus text fields workerId / status. Segmented burn-in
  // uploads burnin_<i>.mp4; final burn-in uploads final-burnin.mp4.
  router.post('/tasks/:id/result-file', async (req, res) => {
    const found = findTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'task not found' });
    const { job, task } = found;
    if (task.type !== 'burnin' && task.type !== 'final-burnin') return res.status(400).json({ error: 'result-file is only for burn-in tasks' });
    if (task.state !== 'assigned') return res.status(409).json({ error: 'task is not assigned' });
    const ct = req.headers['content-type'] || '';
    const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!m) return res.status(400).json({ error: 'expected multipart/form-data' });
    const boundary = (m[1] || m[2]).trim();
    const resultsDir = store.jobPath(job.id, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const finalName = task.type === 'final-burnin' ? 'final-burnin.mp4' : `burnin_${task.segmentIndex}.mp4`;
    const tmpPath = path.join(resultsDir, finalName + '.tmp');
    try {
      const { fields, files } = await parseMultipart(req, boundary, (fieldname) => {
        if (fieldname !== 'file') throw new Error('unexpected file field: ' + fieldname);
        return tmpPath;
      });
      if (fields.workerId && task.workerId && fields.workerId !== task.workerId) {
        fs.rmSync(tmpPath, { force: true });
        return res.status(403).json({ error: 'task is assigned to another worker' });
      }
      if (fields.status && fields.status !== 'done') {
        fs.rmSync(tmpPath, { force: true });
        return res.status(400).json({ error: 'status must be done' });
      }
      const file = files.find((f) => f.fieldname === 'file');
      if (!file || file.size === 0) {
        fs.rmSync(tmpPath, { force: true });
        return res.status(400).json({ error: 'missing burned segment file' });
      }
      fs.renameSync(tmpPath, path.join(resultsDir, finalName));
      runner.completeTask(job, task, { status: 'done', result: { file: `results/${finalName}` } });
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      return res.status(400).json({ error: String(err?.message || err) });
    }
    runner.tick().catch(() => {});
    res.json({ ok: true });
  });

  return router;
}
