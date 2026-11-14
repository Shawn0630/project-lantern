// REST API for LanTask manager.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { parseMultipart } from './multipart.js';
import { newId } from './store.js';

const DOWNLOADABLE = {
  'source.srt': (job) => job.outputs.sourceSrt,
  'translated.srt': (job) => job.outputs.translatedSrt,
  'bilingual.srt': (job) => job.outputs.bilingualSrt,
  'video.mp4': (job) => job.outputs.video,
  'soft.mp4': (job) => job.outputs.softVideo,
};

export function createRouter(store, runner) {
  const router = express.Router();

  const findTask = (taskId) => runner.findTask(taskId);

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

  router.get('/health', (req, res) => res.json({ ok: true, version: '1.2.0' }));

  // ---- jobs ----
  router.get('/jobs', (req, res) => {
    const jobs = store.listJobs().map((j) => ({
      id: j.id,
      name: j.name,
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
      const video = files.find((f) => f.fieldname === 'video');
      if (!video) return res.status(400).json({ error: 'missing video file (field "video")' });
      const job = runner.createJob(fields, { path: video.path, originalName: video.filename || 'video.mp4' });
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

  // ---- workers ----
  router.get('/workers', (req, res) => res.json(store.listWorkers().map((w) => ({
    ...w,
    currentTask: currentTaskForWorker(w),
  }))));

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
      version: null,
      createdAt: new Date().toISOString(),
    };
    workers.push(worker);
    store.saveWorkers(workers);
    res.status(201).json(worker);
  });

  router.delete('/workers/:id', (req, res) => {
    const workers = store.listWorkers().filter((w) => w.id !== req.params.id);
    store.saveWorkers(workers);
    res.json({ ok: true });
  });

  router.post('/workers/heartbeat', (req, res) => {
    const { id, host, port, name, load, model, version, capabilities, ffmpeg, stats } = req.body || {};
    if (!host || !port) return res.status(400).json({ error: 'host and port are required' });
    const workers = store.listWorkers();
    let worker = (id && workers.find((w) => w.id === id)) ||
      workers.find((w) => w.host === host && Number(w.port) === Number(port));
    if (!worker) {
      worker = {
        id: newId('worker'),
        workerId: id || null,
        name: name || `${host}:${port}`,
        host,
        port: Number(port),
        status: 'online',
        registered: false,
        lastSeen: new Date().toISOString(),
        load: load ?? null,
        model: model || null,
        version: version || null,
        capabilities: Array.isArray(capabilities) ? capabilities : null,
        ffmpeg: ffmpeg ?? null,
        stats: stats ?? null,
        createdAt: new Date().toISOString(),
      };
      workers.push(worker);
    } else {
      worker.status = 'online';
      worker.lastSeen = new Date().toISOString();
      if (id && !worker.workerId) worker.workerId = id;
      if (load !== undefined) worker.load = load;
      if (model) worker.model = model;
      if (version) worker.version = version;
      if (name) worker.name = name;
      if (Array.isArray(capabilities)) worker.capabilities = capabilities;
      if (ffmpeg !== undefined) worker.ffmpeg = ffmpeg;
      if (stats !== undefined) worker.stats = stats;
    }
    store.saveWorkers(workers);
    res.json({ id: worker.id, registered: worker.registered });
  });

  // ---- tasks (worker-pull) ----
  router.get('/tasks/next', (req, res) => {
    const { type, workerId } = req.query;
    if (type !== 'transcribe' && type !== 'translate' && type !== 'burnin') {
      return res.status(400).json({ error: 'type must be transcribe, translate or burnin' });
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
    } else if (task.type === 'burnin' && req.query.part) {
      // Burn-in tasks fetch their two inputs separately.
      const seg = job.burnSegments[task.segmentIndex];
      const rel = req.query.part === 'video' ? seg?.file : req.query.part === 'ass' ? seg?.assFile : null;
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

  // Burn-in result upload: the encoded segment is a file, too large for the
  // JSON result endpoint. The worker posts multipart form-data with the file
  // in field "file" plus text fields workerId / status.
  router.post('/tasks/:id/result-file', async (req, res) => {
    const found = findTask(req.params.id);
    if (!found) return res.status(404).json({ error: 'task not found' });
    const { job, task } = found;
    if (task.type !== 'burnin') return res.status(400).json({ error: 'result-file is only for burn-in tasks' });
    if (task.state !== 'assigned') return res.status(409).json({ error: 'task is not assigned' });
    const ct = req.headers['content-type'] || '';
    const m = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!m) return res.status(400).json({ error: 'expected multipart/form-data' });
    const boundary = (m[1] || m[2]).trim();
    const resultsDir = store.jobPath(job.id, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const finalName = `burnin_${task.segmentIndex}.mp4`;
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
