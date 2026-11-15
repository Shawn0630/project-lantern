// Lantern UI: Jobs / Workers / Job detail. Polls the manager API.
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

// ---- new job: pick a type first, then render that type's form ----
// The form is built from the GET /api/job-types schema, so a new job
// type needs no UI change — only a registry entry server-side.
let jobTypes = [];
let selectedJobType = null;

async function loadJobTypes() {
  try {
    jobTypes = await api('/api/job-types');
  } catch {
    jobTypes = [];
  }
  renderTypePicker();
  if (!selectedJobType && jobTypes.length) selectJobType(jobTypes[0].id);
}

function renderTypePicker() {
  $('#job-type-picker').innerHTML = jobTypes.map((t) => `<button type="button"
    class="type-card${selectedJobType && t.id === selectedJobType.id ? ' selected' : ''}"
    data-type="${esc(t.id)}">${esc(t.name)}</button>`).join('')
    || '<div class="empty-state">No job types available</div>';
}

function fieldHtml(f) {
  if (f.kind === 'file') {
    return `<label class="field field-file"><span class="field-label">${esc(f.label)}</span>
      <span class="dropzone" data-dropzone="${esc(f.key)}">
        <span class="dropzone-text">Drop file here or choose</span>
        <span class="dropzone-file" hidden></span>
        <input type="file" name="${esc(f.key)}" accept="${esc(f.accept || '')}"${f.required ? ' required' : ''} hidden>
      </span></label>`;
  }
  if (f.kind === 'select') {
    return `<label class="field"><span class="field-label">${esc(f.label)}</span>
      <select name="${esc(f.key)}">${(f.options || []).map((o) =>
        `<option value="${esc(o.value)}"${o.value === f.default ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  }
  if (f.kind === 'number') {
    return `<label class="field"><span class="field-label">${esc(f.label)}</span>
      <input type="number" name="${esc(f.key)}" value="${esc(f.default ?? '')}"${f.min != null ? ` min="${esc(f.min)}"` : ''}${f.max != null ? ` max="${esc(f.max)}"` : ''}${f.step != null ? ` step="${esc(f.step)}"` : ''}></label>`;
  }
  if (f.kind === 'checkbox') {
    return `<label class="field field-toggle"><span class="switch"><input type="checkbox" name="${esc(f.key)}"${f.default ? ' checked' : ''}><span class="switch-slider"></span></span><span class="field-label">${esc(f.label)}</span></label>`;
  }
  return '';
}

function renderJobForm(type) {
  const form = $('#upload-form');
  const fields = type.fields.filter((f) => f.kind !== 'checkbox');
  const toggles = type.fields.filter((f) => f.kind === 'checkbox');
  form.innerHTML = `<div class="form-grid">${fields.map(fieldHtml).join('')}</div>`
    + (toggles.length ? `<div class="toggles">${toggles.map(fieldHtml).join('')}</div>` : '')
    + `<div class="form-actions"><button type="submit" class="btn-primary">Upload</button><span id="upload-status"></span></div>`;
  form.hidden = false;
  wireDropzones(form);
}

function wireDropzones(form) {
  form.querySelectorAll('[data-dropzone]').forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const showFile = () => {
      const name = input.files && input.files[0] ? input.files[0].name : '';
      zone.querySelector('.dropzone-text').hidden = !!name;
      const fileEl = zone.querySelector('.dropzone-file');
      fileEl.hidden = !name;
      fileEl.textContent = name;
    };
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', showFile);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        showFile();
      }
    });
  });
}

function selectJobType(id) {
  const type = jobTypes.find((t) => t.id === id);
  if (!type) return;
  selectedJobType = type;
  renderTypePicker();
  renderJobForm(type);
}

$('#job-type-picker').addEventListener('click', (e) => {
  const card = e.target.closest('[data-type]');
  if (card) selectJobType(card.dataset.type);
});

function stagePill(stage) {
  const cls = stage === 'done' ? 'ok' : stage === 'failed' ? 'bad' : 'run';
  return `<span class="pill ${cls}">${esc(stage)}</span>`;
}

async function loadJobs() {
  const jobs = await api('/api/jobs');
  const tbody = $('#jobs-table tbody');
  tbody.innerHTML = jobs.map((j) => {
    const pct = j.tasksTotal ? Math.round((100 * j.tasksDone) / j.tasksTotal) : (j.stage === 'done' ? 100 : 0);
    return `<tr>
      <td><span class="job-name">${esc(j.name)}</span><br><small>${esc(j.id)}</small></td>
      <td>${stagePill(j.stage)}${j.error ? `<br><small class="err">${esc(j.error)}</small>` : ''}</td>
      <td><span class="progress"><span class="progress-fill" style="width:${pct}%"></span></span> ${j.tasksDone}/${j.tasksTotal} (${pct}%)</td>
      <td>${fmtTime(j.duration)}</td>
      <td>${fmtAgo(j.createdAt)}</td>
      <td><a href="#/jobs/${esc(j.id)}">Open</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty-state">No jobs yet</div></td></tr>';
}

function fmtStats(stats) {
  if (!stats) return '—';
  const parts = [];
  if (stats.cpuPercent != null) parts.push(`CPU ${stats.cpuPercent}%`);
  if (stats.memUsedMb != null && stats.memTotalMb != null) {
    parts.push(`MEM ${(stats.memUsedMb / 1024).toFixed(1)}/${(stats.memTotalMb / 1024).toFixed(1)} GB`);
  }
  if (stats.loadAvg1 != null) parts.push(`load ${stats.loadAvg1}`);
  return parts.length ? parts.join(' · ') : '—';
}

function fmtCurrentTask(ct) {
  if (!ct) return '—';
  const n = ct.chunkIndex ?? ct.groupIndex ?? ct.segmentIndex;
  const label = `${ct.type}${n == null ? '' : ' #' + n}`;
  return `<a href="#/jobs/${esc(ct.jobId)}">${esc(ct.jobName)} — ${esc(label)}</a>`;
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
    <td>${fmtCurrentTask(w.currentTask)}</td>
    <td>${esc(w.model || '—')}</td>
    <td>${Array.isArray(w.capabilities) ? esc(w.capabilities.join(', ')) : '—'}</td>
    <td>${esc(fmtStats(w.stats))}</td>
    <td><button data-del-worker="${esc(w.id)}">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="10">No workers yet</td></tr>';
}

async function loadJobDetail(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  $('#job-title').textContent = `${job.name} — ${job.stage}`;
  const meta = [
    ['Type', job.jobType || 'video-translation'],
    ['ID', job.id],
    ['Created', new Date(job.createdAt).toLocaleString()],
    ['Duration', fmtTime(job.duration)],
    ['Source', job.config.sourceLang],
    ['Target', job.config.targetLang],
    ['Model', job.config.model],
    ['Chunk', `${job.config.chunkMin} min / ${job.config.overlapSec}s overlap`],
    ['Burn chunk', `${job.config.burnChunkMin} min`],
    ['Translate', job.config.translate ? 'yes' : 'no'],
    ['Burn-in', job.config.burnIn ? 'yes' : 'no'],
    ['Bilingual', job.config.bilingual ? 'yes' : 'no'],
    ['Error', job.error || '—'],
  ];
  $('#job-meta').innerHTML = meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#chunks-table tbody').innerHTML = job.chunks.map((c) => `<tr>
    <td>${c.index}</td><td>${fmtTime(c.start)} – ${fmtTime(c.end)}</td><td>${esc(c.state)}</td>
  </tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
  $('#burn-table tbody').innerHTML = (job.burnSegments || []).map((s) => `<tr>
    <td>${s.index}</td><td>${fmtTime(s.start)} – ${fmtTime(s.end)}</td><td>${esc(s.state)}</td>
  </tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
  $('#tasks-table tbody').innerHTML = job.tasks.map((t) => `<tr>
    <td>${esc(t.id)}</td><td>${esc(t.type)} ${t.chunkIndex ?? t.groupIndex ?? ''}</td>
    <td>${esc(t.state)}${t.state === 'assigned' ? (t.ack ? ' (acked)' : ' (unacked)') : ''}</td><td>${t.attempts}</td><td>${t.weight ?? 0}</td><td>${esc(t.workerId || '—')}</td>
    <td>${esc(t.error || '')}</td>
  </tr>`).join('') || '<tr><td colspan="7">—</td></tr>';
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
    loadJobTypes().catch(() => {});
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
    if (selectedJobType) {
      fd.set('jobType', selectedJobType.id);
      for (const f of selectedJobType.fields) {
        if (f.kind === 'checkbox') fd.set(f.key, e.target.elements[f.key].checked ? 'true' : 'false');
      }
    }
    const res = await fetch('/api/jobs', { method: 'POST', body: fd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    status.textContent = 'Uploaded: ' + body.id;
    if (selectedJobType) renderJobForm(selectedJobType);
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
