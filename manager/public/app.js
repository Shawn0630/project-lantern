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

function fmtSize(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return `${u === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
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
// The video can come from an upload or from the repo: the source toggle
// swaps the file dropzone for a repo-video select. Either way the job is
// created from a repo video — an upload first goes into the repo (POST
// /api/repo/videos), then the job references the returned video id, so
// the file stays available for later jobs.
let jobTypes = [];
let selectedJobType = null;
let jobSource = 'upload'; // 'upload' | 'repo'
let pendingRepoVideoId = null;

function renderSourcePicker() {
  $$('#job-source-picker [data-source]').forEach((b) =>
    b.classList.toggle('selected', b.dataset.source === jobSource));
}

function setJobSource(source, preselectVideoId) {
  jobSource = source;
  if (preselectVideoId) pendingRepoVideoId = preselectVideoId;
  renderSourcePicker();
  if (selectedJobType) renderJobForm(selectedJobType);
}

async function refreshRepoSelect() {
  const sel = $('#repo-video-select');
  if (!sel) return;
  try {
    const videos = await api('/api/repo/videos');
    if (!videos.length) {
      sel.innerHTML = '<option value="">(repo is empty — upload a video first)</option>';
      return;
    }
    const want = pendingRepoVideoId;
    sel.innerHTML = videos.map((v) => `<option value="${esc(v.id)}"${v.id === want ? ' selected' : ''}>${esc(v.filename)} (${fmtSize(v.size)})</option>`).join('');
    pendingRepoVideoId = null;
  } catch {
    sel.innerHTML = '<option value="">(could not load repo)</option>';
  }
}

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
    class="seg-btn${selectedJobType && t.id === selectedJobType.id ? ' selected' : ''}"
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
  const fields = type.fields.filter((f) => f.kind !== 'checkbox' && (jobSource !== 'repo' || f.kind !== 'file'));
  const toggles = type.fields.filter((f) => f.kind === 'checkbox');
  const repoHtml = jobSource === 'repo'
    ? `<div class="form-grid"><label class="field"><span class="field-label">Repo video</span>
      <select name="repoVideo" id="repo-video-select"><option value="">Loading…</option></select></label></div>`
    : '';
  form.innerHTML = repoHtml + `<div class="form-grid">${fields.map(fieldHtml).join('')}</div>`
    + (toggles.length ? `<div class="toggles">${toggles.map(fieldHtml).join('')}</div>` : '')
    + `<div class="form-actions"><button type="submit" class="btn-primary">Create job</button><span id="upload-status"></span></div>`;
  form.hidden = false;
  wireDropzones(form);
  if (jobSource === 'repo') refreshRepoSelect();
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

$('#job-source-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-source]');
  if (btn) setJobSource(btn.dataset.source);
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

// ---- repo: upload into the video library, list, delete, new job ----
async function loadRepo() {
  const videos = await api('/api/repo/videos');
  const tbody = $('#repo-table tbody');
  tbody.innerHTML = videos.map((v) => `<tr>
    <td><span class="job-name">${esc(v.filename)}</span><br><small>${esc(v.id)}</small></td>
    <td>${fmtSize(v.size)}</td>
    <td>${fmtAgo(v.uploadedAt)}</td>
    <td><button data-repo-job="${esc(v.id)}">New job</button> <button data-del-repo="${esc(v.id)}">Delete</button></td>
  </tr>`).join('') || '<tr><td colspan="4"><div class="empty-state">Repo is empty — upload a video above.</div></td></tr>';
}

// Repo upload uses XHR (not fetch) so a multi-GB upload can show
// progress; fetch gives no upload-progress events.
function submitRepoUpload(form) {
  const status = $('#repo-upload-status');
  const input = form.querySelector('input[type="file"]');
  if (!input.files || !input.files.length) {
    status.textContent = 'Choose a video file first';
    return;
  }
  const fd = new FormData();
  fd.append('file', input.files[0]);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/repo/videos');
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) status.textContent = `Uploading… ${Math.round((100 * ev.loaded) / ev.total)}%`;
  };
  xhr.onload = () => {
    if (xhr.status === 201) {
      status.textContent = 'Uploaded';
      form.reset();
      const zone = form.querySelector('[data-dropzone]');
      if (zone) {
        zone.querySelector('.dropzone-text').hidden = false;
        const fileEl = zone.querySelector('.dropzone-file');
        fileEl.hidden = true;
        fileEl.textContent = '';
      }
      loadRepo();
    } else {
      let msg = `HTTP ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep status */ }
      status.textContent = 'Upload failed: ' + msg;
    }
  };
  xhr.onerror = () => { status.textContent = 'Upload failed: network error'; };
  status.textContent = 'Uploading… 0%';
  xhr.send(fd);
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

// Downloaded models: the loaded one gets a star, the rest list plain.
function fmtModels(models) {
  if (!models || !Array.isArray(models.available) || models.available.length === 0) return '—';
  return models.available.map((m) => (m === models.loaded ? `${esc(m)} ★` : esc(m))).join(', ');
}

function fmtWorkerLlm(w) {
  if (!w.llm) return 'global';
  const parts = [w.llm.model ? esc(w.llm.model) : 'global model'];
  parts.push(w.llm.configured ? `key ${esc(w.llm.keyHint || '••••')}` : 'global key');
  return parts.join(' · ');
}

async function loadWorkers() {
  const workers = await api('/api/workers');
  const tbody = $('#workers-table tbody');
  // 7 columns, two-line cells: every field from the old 13-column table
  // is still shown, grouped so the table fits its card without scrolling.
  tbody.innerHTML = workers.map((w) => {
    const pinParts = [];
    if (w.modelPin) pinParts.push(`pin: ${esc(w.modelPin)}`);
    if (w.enginePin) pinParts.push(`engine: ${esc(w.enginePin)}`);
    const models = fmtModels(w.models);
    const modelSub = [...pinParts, models === '—' ? null : models].filter(Boolean).join(' · ');
    const caps = Array.isArray(w.capabilities) && w.capabilities.length ? esc(w.capabilities.join(', ')) : '—';
    return `<tr>
    <td data-label="Worker"><span class="cell-main">${esc(w.name)}${w.registered ? '' : ' <small>(auto)</small>'}</span><span class="cell-sub">${esc(w.host)}:${esc(w.port)}</span></td>
    <td data-label="Status"><span class="cell-main">${esc(w.status)}</span><span class="cell-sub">${fmtAgo(w.lastSeen)}</span></td>
    <td data-label="Load"><span class="cell-main">${w.load == null ? '—' : esc(w.load)}</span><span class="cell-sub">${fmtCurrentTask(w.currentTask)}</span></td>
    <td data-label="Model"><span class="cell-main">${esc(w.model || '—')}</span>${modelSub ? `<span class="cell-sub">${modelSub}</span>` : ''}</td>
    <td data-label="LLM"><span class="cell-main">${fmtWorkerLlm(w)}</span><span class="cell-sub">${caps}</span></td>
    <td data-label="Resources">${esc(fmtStats(w.stats))}</td>
    <td><span class="row-actions"><button data-settings-worker="${esc(w.id)}">Settings</button><button data-del-worker="${esc(w.id)}">Delete</button></span></td>
  </tr>`;
  }).join('') || '<tr><td colspan="7">No workers yet</td></tr>';
}

// ---- worker settings: model pin + engine pin + per-worker LLM override ----
// The pin/model/engine options come from GET /api/job-types (the same list
// the job form offers); the fallback only matters if that fetch fails.
let modelOptions = null;
let engineOptions = null;
let settingsWorkerId = null;

async function ensureModelOptions() {
  if (modelOptions) return modelOptions;
  try {
    const types = await api('/api/job-types');
    const type = types.find((t) => t.id === 'video-translation');
    const field = type && type.fields.find((f) => f.key === 'model');
    modelOptions = (field && field.options.map((o) => o.value)) || [];
  } catch {
    modelOptions = [];
  }
  if (!modelOptions.length) modelOptions = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
  return modelOptions;
}

async function ensureEngineOptions() {
  if (engineOptions) return engineOptions;
  try {
    const types = await api('/api/job-types');
    const type = types.find((t) => t.id === 'video-translation');
    const field = type && type.fields.find((f) => f.key === 'engine');
    engineOptions = (field && field.options.map((o) => o.value)) || [];
  } catch {
    engineOptions = [];
  }
  if (!engineOptions.length) engineOptions = ['faster-whisper', 'whisperjav'];
  return engineOptions;
}

async function openWorkerSettings(id) {
  const workers = await api('/api/workers');
  const w = workers.find((x) => x.id === id);
  if (!w) return;
  settingsWorkerId = id;
  const options = await ensureModelOptions();
  const engineOpts = await ensureEngineOptions();
  $('#worker-settings-name').textContent = w.name;
  $('#worker-settings-pin').innerHTML = '<option value="">(no pin — any model)</option>' +
    options.map((m) => `<option value="${esc(m)}"${w.modelPin === m ? ' selected' : ''}>${esc(m)}</option>`).join('');
  $('#worker-settings-engine-pin').innerHTML = '<option value="">(no pin — any engine)</option>' +
    engineOpts.map((e) => `<option value="${esc(e)}"${w.enginePin === e ? ' selected' : ''}>${esc(e)}</option>`).join('');
  $('#worker-settings-llm-model').value = (w.llm && w.llm.model) || '';
  const keyInput = $('#worker-settings-llm-key');
  keyInput.value = '';
  keyInput.placeholder = (w.llm && w.llm.keyHint) ? `${w.llm.keyHint} — leave blank to keep` : 'leave blank to keep global key';
  $('#worker-settings-status').textContent = '';
  $('#worker-settings-card').hidden = false;
}

async function saveWorkerSettings(body) {
  if (!settingsWorkerId) return;
  await api(`/api/workers/${encodeURIComponent(settingsWorkerId)}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  loadWorkers();
  openWorkerSettings(settingsWorkerId);
}

$('#worker-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!settingsWorkerId) return;
  const status = $('#worker-settings-status');
  const llmKey = $('#worker-settings-llm-key').value;
  const body = {
    modelPin: $('#worker-settings-pin').value || null,
    enginePin: $('#worker-settings-engine-pin').value || null,
    llm: { model: $('#worker-settings-llm-model').value.trim() },
  };
  // The key is only sent when typed: blank keeps the stored one.
  if (llmKey) body.llm.apiKey = llmKey;
  status.textContent = 'Saving…';
  try {
    await saveWorkerSettings(body);
    $('#worker-settings-status').textContent = 'Saved';
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  }
});

$('#worker-settings-clear-pin').addEventListener('click', async () => {
  try {
    await saveWorkerSettings({ modelPin: null, enginePin: null });
    $('#worker-settings-status').textContent = 'Pin cleared';
  } catch (err) {
    $('#worker-settings-status').textContent = 'Clear failed: ' + err.message;
  }
});

$('#worker-settings-reset-llm').addEventListener('click', async () => {
  try {
    await saveWorkerSettings({ llm: null });
    $('#worker-settings-status').textContent = 'LLM reset to global';
  } catch (err) {
    $('#worker-settings-status').textContent = 'Reset failed: ' + err.message;
  }
});

async function loadJobDetail(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  $('#job-title').textContent = `${job.name} — ${job.stage}`;
  const meta = [
    ['Type', job.jobType || 'video-translation'],
    ['ID', job.id],
    ['Created', new Date(job.createdAt).toLocaleString()],
    ['Duration', fmtTime(job.duration)],
    ['Source', job.config.sourceLang],
    ['Video source', job.repoVideoId ? `repo (${job.repoVideoId})` : 'upload'],
    ['Target', job.config.targetLang],
    ['Model', job.config.model],
    ['Engine', job.config.engine || 'faster-whisper'],
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
  $$('#view-jobs, #view-repo, #view-workers, #view-job').forEach((el) => { el.hidden = true; });
  $$('header nav a').forEach((a) => a.classList.remove('active'));
  clearInterval(pollTimer);
  if (m) {
    currentView = 'job';
    $('#view-job').hidden = false;
    loadJobDetail(m[1]).catch(() => {});
    pollTimer = setInterval(() => loadJobDetail(m[1]).catch(() => {}), 2000);
  } else if (hash === '#/repo') {
    currentView = 'repo';
    $('[data-nav="repo"]').classList.add('active');
    $('#view-repo').hidden = false;
    loadRepo().catch(() => {});
    pollTimer = setInterval(() => loadRepo().catch(() => {}), 5000);
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
  status.textContent = 'Creating job…';
  try {
    const form = e.target;
    // Non-file fields only: the file input never goes to /api/jobs. An
    // upload first lands in the repo; the job is then created from the
    // returned repo video id, same as the From-repo path.
    const jobFd = new FormData();
    for (const [k, v] of new FormData(form).entries()) {
      if (v instanceof File) continue;
      jobFd.append(k, v);
    }
    if (selectedJobType) {
      jobFd.set('jobType', selectedJobType.id);
      for (const f of selectedJobType.fields) {
        if (f.kind === 'checkbox') jobFd.set(f.key, form.elements[f.key].checked ? 'true' : 'false');
      }
    }
    if (jobSource === 'upload') {
      const fileInput = form.querySelector('input[type="file"]');
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) throw new Error('choose a video file first');
      status.textContent = 'Uploading to repo…';
      const repoFd = new FormData();
      repoFd.append('file', file);
      const upRes = await fetch('/api/repo/videos', { method: 'POST', body: repoFd });
      const upBody = await upRes.json().catch(() => ({}));
      if (!upRes.ok) throw new Error(upBody.error || `HTTP ${upRes.status}`);
      jobFd.set('repoVideoId', upBody.id);
      status.textContent = 'Creating job…';
    } else {
      const videoId = form.elements.repoVideo ? form.elements.repoVideo.value : '';
      if (!videoId) throw new Error('choose a repo video first');
      jobFd.set('repoVideoId', videoId);
    }
    const res = await fetch('/api/jobs', { method: 'POST', body: jobFd });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    // Re-render first: it rebuilds the form (and the status span), so
    // the confirmation must be written to the fresh element afterwards.
    if (selectedJobType) renderJobForm(selectedJobType);
    loadJobs();
    const freshStatus = $('#upload-status');
    if (freshStatus) freshStatus.textContent = 'Created job: ' + body.id;
  } catch (err) {
    status.textContent = 'Create failed: ' + err.message;
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
  const settingsBtn = e.target.closest('[data-settings-worker]');
  if (settingsBtn) {
    openWorkerSettings(settingsBtn.dataset.settingsWorker).catch(() => {});
    return;
  }
  const repoJobBtn = e.target.closest('[data-repo-job]');
  if (repoJobBtn) {
    // Jump to the Jobs view with the repo video pre-selected in the
    // "From repo" job form. Setting the hash fires route(); the
    // pending id is consumed by refreshRepoSelect once the form renders.
    pendingRepoVideoId = repoJobBtn.dataset.repoJob;
    if (location.hash !== '#/jobs') location.hash = '#/jobs';
    setJobSource('repo', pendingRepoVideoId);
    return;
  }
  const delRepoBtn = e.target.closest('[data-del-repo]');
  if (delRepoBtn) {
    if (!confirm('Delete this video from the repo? Jobs already created from it keep working.')) return;
    await api(`/api/repo/videos/${encodeURIComponent(delRepoBtn.dataset.delRepo)}`, { method: 'DELETE' });
    loadRepo();
    return;
  }
  const btn = e.target.closest('[data-del-worker]');
  if (!btn) return;
  if (!confirm('Delete this worker?')) return;
  await api(`/api/workers/${encodeURIComponent(btn.dataset.delWorker)}`, { method: 'DELETE' });
  if (settingsWorkerId === btn.dataset.delWorker) {
    settingsWorkerId = null;
    $('#worker-settings-card').hidden = true;
  }
  loadWorkers();
});

wireDropzones($('#repo-upload-form'));
$('#repo-upload-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitRepoUpload(e.target);
});

window.addEventListener('hashchange', route);
route();
