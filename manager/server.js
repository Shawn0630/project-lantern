// LanTask manager: Express server + static UI + pipeline ticks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store } from './src/store.js';
import { Runner } from './src/pipeline.js';
import { createRouter } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Minimal .env loader: KEY=VALUE lines, no interpolation, never overrides real env. */
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(repoRoot, 'server', '.env'));

const PORT = Number(process.env.PORT || 9400);
const DATA_DIR = process.env.DATA_DIR || path.join(repoRoot, 'data');

const store = new Store(DATA_DIR);
const runner = new Runner(store);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', createRouter(store, runner));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`LanTask manager listening on :${PORT} (data: ${DATA_DIR})`);
});

const tickTimer = setInterval(() => runner.tick().catch((e) => console.error('tick error', e)), 2000);
const sweepTimer = setInterval(() => {
  try { runner.sweepStale(); } catch (e) { console.error('sweep error', e); }
}, 30000);
runner.tick().catch(() => {});

function shutdown() {
  clearInterval(tickTimer);
  clearInterval(sweepTimer);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
