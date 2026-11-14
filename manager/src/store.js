// File-based state store (no database). Layout under DATA_DIR:
//   workers.json                  — worker registry
//   jobs/<id>/job.json            — job record (config, stages, tasks, logs)
//   jobs/<id>/input/<name>        — uploaded video
//   jobs/<id>/audio.wav           — extracted 16kHz mono audio
//   jobs/<id>/chunks/chunk_000.wav
//   jobs/<id>/results/transcribe_<i>.json | translate_<i>.json
//   jobs/<id>/merged.json | resegmented.json | translated.json
//   jobs/<id>/burn/seg_000.mp4 | ass_000.ass   — burn-in segment video + ASS
//   jobs/<id>/results/burnin_<i>.mp4          — worker-burned segments
//   jobs/<id>/source.srt | translated.srt | bilingual.srt
//   jobs/<id>/video.mp4 | soft.mp4
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.workersPath = path.join(dataDir, 'workers.json');
    if (!fs.existsSync(this.workersPath)) {
      fs.writeFileSync(this.workersPath, '[]\n');
    }
  }

  jobDir(id) {
    return path.join(this.jobsDir, id);
  }

  jobPath(id, ...parts) {
    return path.join(this.jobDir(id), ...parts);
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  // ---- jobs ----
  listJobs() {
    const out = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      const job = this.getJob(name);
      if (job) out.push(job);
    }
    out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return out;
  }

  getJob(id) {
    if (!id || id.includes('/') || id.includes('..')) return null;
    const file = this.jobPath(id, 'job.json');
    if (!fs.existsSync(file)) return null;
    return this.readJson(file, null);
  }

  saveJob(job) {
    this.writeJsonAtomic(this.jobPath(job.id, 'job.json'), job);
    return job;
  }

  deleteJob(id) {
    fs.rmSync(this.jobDir(id), { recursive: true, force: true });
  }

  jobFileExists(id, ...parts) {
    return fs.existsSync(this.jobPath(id, ...parts));
  }

  // ---- workers ----
  listWorkers() {
    return this.readJson(this.workersPath, []);
  }

  saveWorkers(workers) {
    this.writeJsonAtomic(this.workersPath, workers);
  }
}

export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
