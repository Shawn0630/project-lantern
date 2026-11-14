// LanTask UI: Jobs / Workers / Job detail. Polls the manager API.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function fmtTime(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtAgo(iso) {
  if (!iso) return '—';
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function refreshHealth() {
  try {
    await api('/api/health');
    const el = $('#health');
    el.textContent = 'manager ok';
    el.className = 'pill ok';
  } catch {
    const el = $('#health');
    el.textContent = 'manager down';
    el.className = 'pill bad';
  }
}

async function loadJobs() {
  const jobs = await api('/api/jobs');
  const tbody = $('#jobs-table tbody');
  tbody.innerHTML = jobs.map((j) => {
    const pct = j.tasksTotal ? Math.round((100 * j.tasksDone) / j.tasksTotal) : (j.stage === 'done' ? 100 : 0);
    return `<tr>
      <td>${esc(j.name)}<br><small>${esc(j.id)}</small></td>
      <td>${esc(j.stage)}${j.error ? `<br><small>${esc(j.error)}</small>` : ''}</td>
      <td>${j.tasksDone}/${j.tasksTotal} (${pct}%)</td>
      <td>${fmtTime(j.duration)}</td>
      <td>${fmtAgo(j.createdAt)}</td>
      <td><a href="#/jobs/${esc(j.id)}">Open</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6">No jobs yet</td></tr>';
}

async function loadWorkers() {
  const workers = await api('/api/workers');
  const tbody = $('#workers-table tbody');
  tbody.innerHTML = workers.map((w) => `<tr>
    <td>${esc(w.name)}${w.registered ? '' : ' <small>(auto)</small>'}</td>
    <td>${esc(w.host)}:${esc(w.port)}</td>
    <td>${esc(w.status)}</td>
    <td>${fmtAgo(w.lastSeen)}</td>
    <td>${w.load == null ? '—' : esc(w.load)}</td>
    <td>${esc(w.model || '—')}</td>
    <td><button data-del-worker="${esc(w.id)}">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="7">No workers yet</td></tr>';
}

async function loadJobDetail(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  $('#job-title').textContent = `${job.name} — ${job.stage}`;
  const meta = [
    ['ID', job.id],
    ['Created', new Date(job.createdAt).toLocaleString()],
    ['Duration', fmtTime(job.duration)],
    ['Source', job.config.sourceLang],
    ['Target', job.config.targetLang],
    ['Model', job.config.model],
    ['Chunk', `${job.config.chunkMin} min / ${job.config.overlapSec}s overlap`],
    ['Translate', job.config.translate ? 'yes' : 'no'],
    ['Burn-in', job.config.burnIn ? 'yes' : 'no'],
    ['Bilingual', job.config.bilingual ? 'yes' : 'no'],
    ['Error', job.error || '—'],
  ];
  $('#job-meta').innerHTML = meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#chunks-table tbody').innerHTML = job.chunks.map((c) => `<tr>
    <td>${c.index}</td><td>${fmtTime(c.start)} – ${fmtTime(c.end)}</td><td>${esc(c.state)}</td>
  </tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
  $('#tasks-table tbody').innerHTML = job.tasks.map((t) => `<tr>
    <td>${esc(t.id)}</td><td>${esc(t.type)} ${t.chunkIndex ?? t.groupIndex ?? ''}</td>
    <td>${esc(t.state)}</td><td>${t.attempts}</td><td>${esc(t.workerId || '—')}</td>
    <td>${esc(t.error || '')}</td>
  </tr>`).join('') || '<tr><td colspan="6">—</td></tr>';
  const dl = [];
  if (job.outputs.sourceSrt) dl.push(['source.srt', 'source.srt']);
  if (job.outputs.translatedSrt) dl.push(['translated.srt', 'translated.srt']);
  if (job.outputs.bilingualSrt) dl.push(['bilingual.srt', 'bilingual.srt']);
  if (job.outputs.video) dl.push(['video.mp4', 'video.mp4']);
  if (job.outputs.softVideo) dl.push(['soft.mp4', 'soft.mp4']);
  dl.push(['input', 'input']);
  $('#downloads').innerHTML = dl.map(([label, name]) =>
    `<li><a href="/api/jobs/${encodeURIComponent(job.id)}/download/${encodeURIComponent(name)}">${esc(label)}</a></li>`).join('');
  $('#job-log').textContent = (job.logs || []).map((l) => `${l.ts}  ${l.msg}`).join('\n');
}

let currentView = null;
let pollTimer = null;

function route() {
  const hash = location.hash || '#/jobs';
  const m = /^#\/jobs\/([^/]+)$/.exec(hash);
  $$('#view-jobs, #view-workers, #view-job').forEach((el) => { el.hidden = true; });
  $$('header nav a').forEach((a) => a.classList.remove('active'));
  clearInterval(pollTimer);
  if (m) {
    currentView = 'job';
    $('#view-job').hidden = false;
    loadJobDetail(m[1]).catch(() => {});
    pollTimer = setInterval(() => loadJobDetail(m[1]).catch(() => {}), 2000);
  } else if (hash === '#/workers') {
    currentView = 'workers';
    $('[data-nav="workers"]').classList.add('active');
    $('#view-workers').hidden = false;
    loadWorkers().catch(() => {});
    pollTimer = setInterval(() => loadWorkers().catch(() => {}), 5000);
  } else {
    currentView = 'jobs';
    $('[data-nav="jobs"]').classList.add('active');
    $('#view-jobs').hidden = false;
    loadJobs().catch(() => {});
    pollTimer = setInterval(() => loadJobs().catch(() => {}), 2000);
  }
  refreshHealth();
}

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#upload-status');
  status.textContent = 'Uploading…';
  try {
    const fd = new FormData(e.target);
    fd.set('translate', e.target.translate.checked ? 'true' : 'false');
    fd.set('burnIn', e.target.burnIn.checked ? 'true' : 'false');
    fd.set('bilingual', e.target.bilingual.checked ? 'true' : 'false');
    const res = await fetch('/api/jobs', { method: 'POST', body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    status.textContent = 'Uploaded: ' + body.id;
    e.target.reset();
    loadJobs();
  } catch (err) {
    status.textContent = 'Upload failed: ' + err.message;
  }
});

$('#worker-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: fd.get('host'), port: Number(fd.get('port')), name: fd.get('name') || undefined }),
    });
    e.target.reset();
    loadWorkers();
  } catch (err) {
    alert('Add worker failed: ' + err.message);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-worker]');
  if (!btn) return;
  if (!confirm('Delete this worker?')) return;
  await api(`/api/workers/${encodeURIComponent(btn.dataset.delWorker)}`, { method: 'DELETE' });
  loadWorkers();
});

window.addEventListener('hashchange', route);
route();
