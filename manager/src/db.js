// SQLite store for per-split transcription results.
//
// Why SQLite, why node:sqlite:
//   - Single file under DATA_DIR (same ./data volume as everything
//     else), zero extra service — the same trade-off as the file-based
//     store. Workers never touch this file; only the manager does.
//   - Node's built-in node:sqlite (DatabaseSync): no new dependency,
//     no native build. It needs Node >= 22.5 with --experimental-sqlite
//     and is unflagged from Node 24. The manager image is node:22
//     (>= 22.5) and the flag is passed in the Dockerfile CMD and the
//     npm test script; the flag is accepted (no-op) on Node 24.
//   - WAL mode + busy_timeout so concurrent worker completions don't
//     trip on a locked DB. Calls are synchronous and the manager is
//     single-threaded, so contention is minimal by construction.
//
// Schema:
//   chunks(job_id, chunk_index, start, end, state)
//     — one row per audio chunk of a job; start/end are absolute seconds.
//   segments(job_id, chunk_index, seg_index, start, end, text,
//            words_json, engine, model, created_at)
//     — one row per ASR segment; start/end/words are CHUNK-RELATIVE
//     seconds, exactly as the worker reports them (merge() applies the
//     chunk offset, same as it did from the JSON files).
//   chunk_results(job_id, chunk_index, result_json, created_at)
//     — the raw per-chunk result payload, kept verbatim for audit and
//     rollback; segments is the queryable source of truth for merging.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB_FILENAME = 'lantern.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  PRIMARY KEY (job_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS segments (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  seg_index INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT,
  engine TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, chunk_index, seg_index)
);
CREATE INDEX IF NOT EXISTS idx_segments_job
  ON segments (job_id, chunk_index, seg_index);
CREATE TABLE IF NOT EXISTS chunk_results (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, chunk_index)
);
`;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export class LanternDb {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.stmt = {
      upsertChunk: this.db.prepare(
        `INSERT INTO chunks (job_id, chunk_index, start, end, state)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id, chunk_index) DO UPDATE
         SET start = excluded.start, end = excluded.end, state = excluded.state`,
      ),
      deleteSegments: this.db.prepare(
        'DELETE FROM segments WHERE job_id = ? AND chunk_index = ?',
      ),
      insertSegment: this.db.prepare(
        `INSERT INTO segments
           (job_id, chunk_index, seg_index, start, end, text, words_json, engine, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertChunkResult: this.db.prepare(
        `INSERT INTO chunk_results (job_id, chunk_index, result_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id, chunk_index) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at`,
      ),
      listChunks: this.db.prepare(
        'SELECT chunk_index, start, end, state FROM chunks WHERE job_id = ? ORDER BY chunk_index',
      ),
      listSegments: this.db.prepare(
        `SELECT seg_index, start, end, text, words_json, engine, model
         FROM segments WHERE job_id = ? AND chunk_index = ? ORDER BY seg_index`,
      ),
      hasChunk: this.db.prepare(
        'SELECT 1 AS one FROM chunks WHERE job_id = ? AND chunk_index = ?',
      ),
      countSegments: this.db.prepare(
        'SELECT COUNT(*) AS n FROM segments WHERE job_id = ?',
      ),
      deleteJobSegments: this.db.prepare('DELETE FROM segments WHERE job_id = ?'),
      deleteJobResults: this.db.prepare('DELETE FROM chunk_results WHERE job_id = ?'),
      deleteJobChunks: this.db.prepare('DELETE FROM chunks WHERE job_id = ?'),
    };
  }

  runInTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Store one chunk's transcribe result. Idempotent: saving the same
   * chunk again (retry / re-run / re-migration) replaces its rows
   * instead of duplicating them. */
  saveTranscribeResult({ jobId, chunkIndex, chunkStart, chunkEnd, segments, rawResult, engine, model }) {
    const list = Array.isArray(segments) ? segments : [];
    const now = new Date().toISOString();
    this.runInTransaction(() => {
      this.stmt.deleteSegments.run(jobId, chunkIndex);
      this.stmt.upsertChunk.run(jobId, chunkIndex, num(chunkStart), num(chunkEnd), 'done');
      for (let i = 0; i < list.length; i++) {
        const seg = list[i] || {};
        this.stmt.insertSegment.run(
          jobId, chunkIndex, i,
          num(seg.start), num(seg.end), String(seg.text ?? ''),
          Array.isArray(seg.words) ? JSON.stringify(seg.words) : null,
          engine ?? null, model ?? null, now,
        );
      }
      this.stmt.upsertChunkResult.run(
        jobId, chunkIndex,
        JSON.stringify(rawResult ?? { segments: list }),
        now,
      );
    });
  }

  /** Chunk-relative segments for one chunk, or null when the chunk has
   * no DB rows at all (caller falls back to the legacy JSON file). */
  getChunkSegments(jobId, chunkIndex) {
    if (!this.stmt.hasChunk.get(jobId, chunkIndex)) return null;
    return this.stmt.listSegments.all(jobId, chunkIndex).map((row) => {
      const seg = { text: row.text, start: row.start, end: row.end };
      if (row.words_json) {
        try {
          const words = JSON.parse(row.words_json);
          if (Array.isArray(words)) seg.words = words;
        } catch { /* malformed words: drop them, keep the text */ }
      }
      return seg;
    });
  }

  /** All chunks of a job with their segments, ordered by chunk_index,
   * in the { offset, segments } shape mergeChunks() takes. */
  getTranscribeChunks(jobId) {
    return this.stmt.listChunks.all(jobId).map((chunk) => ({
      offset: chunk.start,
      segments: this.getChunkSegments(jobId, chunk.chunk_index) || [],
    }));
  }

  countSegments(jobId) {
    return this.stmt.countSegments.get(jobId)?.n ?? 0;
  }

  /** Remove every row for a job (called when the job is deleted). */
  deleteJob(jobId) {
    this.runInTransaction(() => {
      this.stmt.deleteJobSegments.run(jobId);
      this.stmt.deleteJobResults.run(jobId);
      this.stmt.deleteJobChunks.run(jobId);
    });
  }

  close() {
    this.db.close();
  }
}

export function openLanternDb(dataDir) {
  return new LanternDb(path.join(dataDir, DB_FILENAME));
}

/** One-off import of pre-DB transcribe results from
 * jobs/<id>/results/transcribe_<i>.json into the DB. Idempotent:
 * re-importing a chunk overwrites its rows (see
 * saveTranscribeResult), so this is safe to run on every manager
 * boot. Returns how many chunk files were imported. */
export function migrateLegacyResults(store, db) {
  let imported = 0;
  for (const job of store.listJobs()) {
    const resultsDir = store.jobPath(job.id, 'results');
    if (!fs.existsSync(resultsDir)) continue;
    for (const name of fs.readdirSync(resultsDir)) {
      const m = /^transcribe_(\d+)\.json$/.exec(name);
      if (!m) continue;
      const chunkIndex = Number(m[1]);
      const result = store.readJson(path.join(resultsDir, name), null);
      if (!result || !Array.isArray(result.segments)) continue;
      const chunk = (job.chunks || []).find((c) => c.index === chunkIndex);
      db.saveTranscribeResult({
        jobId: job.id,
        chunkIndex,
        chunkStart: chunk?.start ?? 0,
        chunkEnd: chunk?.end ?? 0,
        segments: result.segments,
        rawResult: result,
        engine: job.config?.engine ?? null,
        model: job.config?.model ?? null,
      });
      imported += 1;
    }
  }
  return imported;
}
