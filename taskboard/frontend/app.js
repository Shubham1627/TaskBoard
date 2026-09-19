const cfg = Object.assign(
  { appName: 'TaskBoard', apiBase: '/api', banner: '', refreshSeconds: 5 }, window.APP_CONFIG || {});
const $ = (id) => document.getElementById(id);
const seen = new Map(); // hostname -> number of replies

async function api(path, options) {
  const res = await fetch(cfg.apiBase + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (HTTP ${res.status})`);
  return body;
}
const showError = (msg) => { $('error').textContent = msg || ''; $('error').hidden = !msg; };
const fmtUptime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

function renderSeen() {
  const list = $('seen'); list.replaceChildren();
  for (const [host, n] of seen) { const li = document.createElement('li'); li.textContent = `${host} x${n}`; list.append(li); }
}

async function loadInfo() {
  const info = await api('/info');
  $('hostname').textContent = info.hostname;
  $('version').textContent = info.version;
  $('uptime').textContent = fmtUptime(info.uptimeSeconds);
  $('requests').textContent = info.totalApiRequests ?? 'unavailable';
  $('envBadge').textContent = info.env;
  $('appName').textContent = info.app; document.title = info.app;
  seen.set(info.hostname, (seen.get(info.hostname) || 0) + 1); renderSeen();
}

async function loadTasks() {
  const res = await fetch(cfg.apiBase + '/tasks');
  if (!res.ok) throw new Error(`Could not load tasks (HTTP ${res.status})`);
  $('cacheState').textContent = res.headers.get('X-Cache') === 'HIT' ? 'Redis cache' : 'database';
  const tasks = await res.json();
  const ul = $('tasks'); ul.replaceChildren();
  $('empty').hidden = tasks.length > 0;
  for (const t of tasks) ul.append(taskItem(t));
}

function taskItem(t) {
  const li = document.createElement('li'); if (t.done) li.className = 'done';
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = t.done;
  box.setAttribute('aria-label', `Mark "${t.title}" as done`);
  box.onchange = () => act(() => api(`/tasks/${t.id}`, json('PATCH', { done: box.checked })));
  const title = document.createElement('span'); title.className = 'title'; title.textContent = t.title;
  li.append(box, title);

  if (t.attachment_name) {
    const a = document.createElement('a'); a.href = `${cfg.apiBase}/tasks/${t.id}/attachment`; a.textContent = t.attachment_name; li.append(a);
  }
  const attach = document.createElement('label'); attach.className = 'attach';
  attach.append(t.attachment_name ? 'Replace file' : 'Attach file');
  const file = document.createElement('input'); file.type = 'file'; attach.append(file);
  file.onchange = () => { if (!file.files[0]) return; const fd = new FormData(); fd.append('file', file.files[0]);
    act(() => api(`/tasks/${t.id}/attachment`, { method: 'POST', body: fd })); };
  const del = document.createElement('button'); del.className = 'ghost'; del.textContent = 'Delete';
  del.onclick = () => act(() => api(`/tasks/${t.id}`, { method: 'DELETE' }));
  li.append(attach, del);
  return li;
}

const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function act(fn) { try { showError(''); await fn(); await refresh(); } catch (e) { showError(e.message); } }
async function refresh() {
  try { await Promise.all([loadTasks(), loadInfo()]); showError(''); }
  catch (e) { showError(`Cannot reach the backend: ${e.message}`); }
}

$('addForm').onsubmit = (ev) => { ev.preventDefault(); const title = $('title').value.trim(); if (!title) return;
  act(async () => { await api('/tasks', json('POST', { title })); $('title').value = ''; }); };

$('loadBtn').onclick = async () => {
  const n = Math.min(Math.max(parseInt($('loadCount').value, 10) || 1, 1), 200);
  $('loadBtn').disabled = true; $('loadResult').textContent = `Sending ${n} requests...`;
  const results = await Promise.allSettled(Array.from({ length: n }, () => api('/load?ms=1000')));
  const ok = results.filter((r) => r.status === 'fulfilled');
  ok.forEach((r) => seen.set(r.value.hostname, (seen.get(r.value.hostname) || 0) + 1));
  renderSeen();
  $('loadResult').textContent = `${ok.length} of ${n} requests succeeded.`;
  $('loadBtn').disabled = false;
};

if (cfg.banner) { $('banner').textContent = cfg.banner; $('banner').hidden = false; }
$('appName').textContent = cfg.appName;
refresh();
setInterval(refresh, Math.max(cfg.refreshSeconds, 2) * 1000);
