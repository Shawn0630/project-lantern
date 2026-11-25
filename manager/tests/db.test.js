// SQLite store for per-split results: DB round-trip, retry
// idempotency, completeTask dual-write, merge-from-DB (with JSON
// fallback), legacy migration, and job deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Runner } from '../src/pipeline.js';
import { LanternDb, migrateLegacyResults } from '../src/db.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SEG_A = [
  { text: 'hello world', start: 0, end: 2, words: [{ text: 'hello', start: 0, end: 1 }, { text: 'world', start: 1, end: 2 }] },
  { text: 'the quick brown fox', start: 10, end: 12, words: [{ text: 'the', start: 10, end: 10.5 }, { text: 'quick', start: 10.5, end: 11 }, { text: 'brown', start: 11, end: 11.5 }, { text: 'fox', start: 11.5, end: 12 }] },
];
const SEG_B = [
  { text: 'the quick brown fox', start: 0, end: 2, words: [{ text: 'the', start: 0, end: 0.5 }, { text: 'quick', start: 0.5, end: 1 }, { text: 'brown', start: 1, end: 1.5 }, { text: 'fox', start: 1.5, end: 2 }] },
  { text: 'jumps over', start: 2, end: 4, words: [{ text: 'jumps', start: 2, end: 3 }, { text: 'over', start: 3, end: 4 }] },
];

function save(db, jobId, chunkIndex, chunkStart, segments, engine = 'faster-whisper', model = 'large-v3') {
  db.saveTranscribeResult({
    jobId, chunkIndex, chunkStart, chunkEnd: chunkStart + 600,
    segments, rawResult: { segments }, engine, model,
  });
}

// ---- LanternDb unit ----
test('db: save + read round-trips segments with word timestamps', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const db = new LanternDb(path.join(dir, 'lantern.db'));
    save(db, 'job_1', 0, 0, SEG_A);
    const got = db.getChunkSegments('job_1', 0);
    assert.equal(got.length, 2);
    assert.equal(got[0].text, 'hello world');
    assert.equal(got[0].start, 0);
    assert.equal(got[0].end, 2);
    assert.deepEqual(got[0].words, SEG_A[0].words);
    // A chunk with no rows reads as null (caller falls back to JSON).
    assert.equal(db.getChunkSegments('job_1', 1), null);
    assert.equal(db.getChunkSegments('job_nope', 0), null);
    assert.equal(db.countSegments('job_1'), 2);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('db: saving the same chunk twice replaces rows, never duplicates', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const db = new LanternDb(path.join(dir, 'lantern.db'));
    save(db, 'job_1', 0, 0, SEG_A);
    save(db, 'job_1', 0, 0, [{ text: 'second try', start: 0, end: 1 }]);
    const got = db.getChunkSegments('job_1', 0);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'second try');
    assert.equal(db.countSegments('job_1'), 1);
    // Other chunks / jobs are untouched.
    save(db, 'job_1', 1, 600, SEG_B);
    save(db, 'job_2', 0, 0, SEG_A);
    assert.equal(db.countSegments('job_1'), 3);
    assert.equal(db.countSegments('job_2'), 2);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('db: getTranscribeChunks returns mergeChunks-shaped chunks in order', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const db = new LanternDb(path.join(dir, 'lantern.db'));
    save(db, 'job_1', 1, 600, SEG_B);
    save(db, 'job_1', 0, 0, SEG_A);
    const chunks = db.getTranscribeChunks('job_1');
    assert.deepEqual(chunks.map((c) => c.offset), [0, 600]);
    assert.equal(chunks[0].segments[0].text, 'hello world');
    assert.equal(chunks[1].segments[1].text, 'jumps over');
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('db: file lives under DATA_DIR in WAL mode', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    assert.equal(store.dbPath, path.join(dir, 'lantern.db'));
    assert.ok(fs.existsSync(store.dbPath));
    const probe = new DatabaseSync(store.dbPath, { readOnly: true });
    assert.equal(probe.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    probe.close();
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---- pipeline integration ----
function makeJob(store, id) {
  const job = {
    id,
    name: 'clip.mp4',
    createdAt: new Date().toISOString(),
    config: {
      sourceLang: 'en', targetLang: 'zh-CN', engine: 'faster-whisper', model: 'large-v3',
      chunkMin: 10, overlapSec: 10, burnChunkMin: 5, translate: false, burnIn: false, bilingual: false,
    },
    stage: 'transcribing',
    duration: 620,
    // Chunk 1 starts 10s in, so its first segment (relative 0-2) lands
    // on chunk 0's overlap segment (absolute 10-12): the merge dedupes
    // the duplicated "the quick brown fox", like merge.test.js.
    chunks: [
      { index: 0, start: 0, end: 600, file: 'chunks/chunk_000.wav', state: 'queued' },
      { index: 1, start: 10, end: 610, file: 'chunks/chunk_001.wav', state: 'queued' },
    ],
    burnSegments: [],
    tasks: [0, 1].map((i) => ({
      id: `task_${i}`, type: 'transcribe', state: 'assigned', attempts: 1, weight: 0,
      queuedAt: '2026-11-25T00:00:00.000Z', ack: true, ackDeadline: null,
      workerId: 'w1', assignedAt: '2026-11-25T00:00:00.000Z', excludeWorker: null,
      requeuedAt: null, error: null, chunkIndex: i,
    })),
    logs: [], outputs: {}, error: null,
  };
  store.saveJob(job);
  return job;
}

test('completeTask dual-writes DB + JSON, and merge reads from the DB', async () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    const runner = new Runner(store, { env: {} });
    const job = makeJob(store, 'job_db1');
    runner.completeTask(job, job.tasks[0], { status: 'done', result: { segments: SEG_A } });
    runner.completeTask(job, job.tasks[1], { status: 'done', result: { segments: SEG_B } });
    // Dual-write: both the DB rows and the legacy JSON files exist.
    assert.equal(store.db.countSegments(job.id), 4);
    assert.ok(fs.existsSync(store.jobPath(job.id, 'results', 'transcribe_0.json')));
    assert.ok(fs.existsSync(store.jobPath(job.id, 'results', 'transcribe_1.json')));
    assert.equal(store.db.getChunkSegments(job.id, 0)[1].text, 'the quick brown fox');
    // Delete the JSON files: merge must still work — the DB is the source.
    fs.rmSync(store.jobPath(job.id, 'results', 'transcribe_0.json'));
    fs.rmSync(store.jobPath(job.id, 'results', 'transcribe_1.json'));
    await runner.merge(job);
    const merged = store.readJson(store.jobPath(job.id, 'merged.json'), null);
    assert.deepEqual(merged.segments.map((s) => s.text), ['hello world', 'the quick brown fox', 'jumps over']);
    assert.equal(job.stage, 'resegmenting');
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('completeTask retry overwrites the DB rows for the chunk', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    const runner = new Runner(store, { env: {} });
    const job = makeJob(store, 'job_db2');
    runner.completeTask(job, job.tasks[0], { status: 'done', result: { segments: SEG_A } });
    // Simulate a retry: the task runs again and reports different text.
    job.tasks[0].state = 'assigned';
    runner.completeTask(job, job.tasks[0], { status: 'done', result: { segments: [{ text: 'retry text', start: 0, end: 1 }] } });
    assert.equal(store.db.countSegments(job.id), 1);
    assert.equal(store.db.getChunkSegments(job.id, 0)[0].text, 'retry text');
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('merge falls back to the JSON file for chunks with no DB rows', async () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    const runner = new Runner(store, { env: {} });
    const job = makeJob(store, 'job_db3');
    // Legacy state: JSON files only, nothing in the DB.
    store.writeJsonAtomic(store.jobPath(job.id, 'results', 'transcribe_0.json'), { segments: SEG_A });
    store.writeJsonAtomic(store.jobPath(job.id, 'results', 'transcribe_1.json'), { segments: SEG_B });
    assert.equal(store.db.countSegments(job.id), 0);
    await runner.merge(job);
    const merged = store.readJson(store.jobPath(job.id, 'merged.json'), null);
    assert.deepEqual(merged.segments.map((s) => s.text), ['hello world', 'the quick brown fox', 'jumps over']);
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('deleteJob removes the job rows from the DB', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    const runner = new Runner(store, { env: {} });
    const job = makeJob(store, 'job_db4');
    runner.completeTask(job, job.tasks[0], { status: 'done', result: { segments: SEG_A } });
    assert.equal(store.db.countSegments(job.id), 2);
    store.deleteJob(job.id);
    assert.equal(store.db.countSegments(job.id), 0);
    assert.equal(store.db.getChunkSegments(job.id, 0), null);
    assert.ok(!fs.existsSync(store.jobDir(job.id)));
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---- migration ----
test('migrateLegacyResults imports JSON-only results, twice is safe', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    const job = makeJob(store, 'job_db5');
    // Simulate a pre-DB job: JSON files exist, DB is empty.
    store.writeJsonAtomic(store.jobPath(job.id, 'results', 'transcribe_0.json'), { segments: SEG_A });
    store.writeJsonAtomic(store.jobPath(job.id, 'results', 'transcribe_1.json'), { segments: SEG_B });
    assert.equal(store.db.countSegments(job.id), 0);
    assert.equal(migrateLegacyResults(store, store.db), 2);
    assert.equal(store.db.countSegments(job.id), 4);
    assert.equal(store.db.getChunkSegments(job.id, 1)[1].text, 'jumps over');
    // Second run imports the same files again but replaces, not duplicates.
    assert.equal(migrateLegacyResults(store, store.db), 2);
    assert.equal(store.db.countSegments(job.id), 4);
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});

test('migrateLegacyResults skips jobs without transcribe files', () => {
  const dir = tmpDir('lantern-db-');
  try {
    const store = new Store(dir);
    makeJob(store, 'job_db6');
    assert.equal(migrateLegacyResults(store, store.db), 0);
    store.db.close();
  } finally {
    cleanupDir(dir);
  }
});
