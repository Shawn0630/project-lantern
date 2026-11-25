// File-based state store (no database). Layout under DATA_DIR:
//   lantern.db                    — SQLite: per-chunk transcribe results
//                                    (chunks / segments / chunk_results;
//                                    see src/db.js). The final SRT is still
//                                    merged by the manager from this DB.
//   workers.json                  — worker registry
//   jobs/<id>/job.json            — job record (config, stages, tasks, logs)
//   jobs/<id>/input/<name>        — uploaded video
//   repo/<id><ext>                 — video library file (LAN repo)
//   repo/videos.json               — repo video metadata (id, filename, size, uploadedAt)
//   jobs/<id>/audio.wav           — extracted 16kHz mono audio
//   jobs/<id>/chunks/chunk_000.wav
//   jobs/<id>/results/transcribe_<i>.json | translate_<i>.json
//   jobs/<id>/merged.json | resegmented.json | translated.json
//   jobs/<id>/burn/seg_000.mp4 | ass_000.ass   — burn-in segment video + ASS
//   jobs/<id>/burn/final.ass                 — total ASS for final burn-in
//   jobs/<id>/results/burnin_<i>.mp4          — worker-burned segments
//   jobs/<id>/results/final-burnin.mp4        — worker-burned whole video (final mode)
//   jobs/<id>/source.srt | translated.srt | bilingual.srt
//   jobs/<id>/video.mp4 | soft.mp4
import fs from 'node:fs';
import path from 'node:path';
import { LanternDb, DB_FILENAME } from './db.js';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    // SQLite DB for per-split results (single file, WAL mode).
    // Every Store instance opens it; the manager is the only process
    // that ever touches it.
    this.dbPath = path.join(dataDir, DB_FILENAME);
    this.db = new LanternDb(this.dbPath);
    this.workersPath = path.join(dataDir, 'workers.json');
    if (!fs.existsSync(this.workersPath)) {
      fs.writeFileSync(this.workersPath, '[]\n');
    }
    // LAN video repo: one file per video + a metadata index.
    this.repoDir = path.join(dataDir, 'repo');
    fs.mkdirSync(this.repoDir, { recursive: true });
    this.repoIndexPath = path.join(this.repoDir, 'videos.json');
    if (!fs.existsSync(this.repoIndexPath)) {
      fs.writeFileSync(this.repoIndexPath, '[]\n');
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
    this.db.deleteJob(id);
  }

  jobFileExists(id, ...parts) {
    return fs.existsSync(this.jobPath(id, ...parts));
  }

  // ---- repo (LAN video library) ----
  // Records: { id, filename, storedName, size, uploadedAt }. The file
  // on disk is <id><ext>; the extension is kept so the repo dir stays
  // browsable, the record is the source of truth for the display name.
  listRepoVideos() {
    const videos = this.readJson(this.repoIndexPath, []);
    if (!Array.isArray(videos)) return [];
    return videos.slice().sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
  }

  getRepoVideo(id) {
    if (!id || id.includes('/') || id.includes('..')) return null;
    return this.listRepoVideos().find((v) => v.id === id) || null;
  }

  repoVideoPath(video) {
    return path.join(this.repoDir, video.storedName);
  }

  addRepoVideo(video) {
    const videos = this.listRepoVideos();
    videos.push(video);
    this.writeJsonAtomic(this.repoIndexPath, videos);
    return video;
  }

  // Removes the metadata record; returns it, or null when unknown.
  // The caller also removes the file. Jobs created from the video
  // keep working: their input is a hard link to the same inode.
  removeRepoVideo(id) {
    const videos = this.listRepoVideos();
    const idx = videos.findIndex((v) => v.id === id);
    if (idx === -1) return null;
    const [removed] = videos.splice(idx, 1);
    this.writeJsonAtomic(this.repoIndexPath, videos);
    return removed;
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
