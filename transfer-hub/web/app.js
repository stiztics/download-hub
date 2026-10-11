const $ = selector => document.querySelector(selector);
const preview = location.pathname === '/phone';
if (preview) document.body.classList.add('phone-preview');
const model = { files: [], queue: [], selection: new Set(), series: null, view: 'library', role: null, query: '', ready: false };
const bytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5500); }
async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status });
  return result;
}
async function action(button, work) { button.disabled = true; try { await work(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }
function showView(view) {
  const previousView = model.view;
  model.view = view;
  $('#library-view').hidden = view !== 'library'; $('#queue-view').hidden = view !== 'queue';
  $('#fetcher-view').hidden = view !== 'fetcher';
  document.querySelectorAll('[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  $('#heading').innerHTML = view === 'library' ? 'Your library<span class="accent">.</span>' : 'Phone queue<span class="accent">.</span>';
  $('#intro').textContent = view === 'library' ? 'Pick a few episodes. Take them with you.' : 'Your next downloads, ready for pickup.';
  $('#breadcrumb').textContent = `YOUR DOWNLOADS / ${view === 'library' ? 'LIBRARY' : 'PHONE QUEUE'}`;
  if (view === 'fetcher') {
    $('#heading').textContent = 'Fetch anime.';
    $('#intro').textContent = 'Find a title. Download it to your PC.';
    $('#breadcrumb').textContent = 'YOUR DOWNLOADS / FETCH ANIME';
    void refreshFetcher();
  }
  if (view === 'library' && previousView === 'fetcher') void refresh().catch(error => toast(error.message, true));
  renderSelection();
  window.scrollTo(0, 0);
}
const visible = () => model.files.filter(file => (!model.series || file.series === model.series) && `${file.series} ${file.title} ${file.filename}`.toLowerCase().includes(model.query));
function renderLibrary() {
  const groups = new Map();
  for (const file of visible()) { if (!groups.has(file.series)) groups.set(file.series, []); groups.get(file.series).push(file); }
  $('#file-total').textContent = model.files.length;
  $('#nav-count').textContent = model.files.length;
  $('#byte-total').textContent = bytes(model.files.reduce((sum, f) => sum + f.bytes, 0));
  $('#series-total').textContent = new Set(model.files.map(f => f.series)).size.toString().padStart(2, '0');
  $('#result-count').textContent = `${visible().length} files · ${groups.size} series`;
  $('#series-grid').hidden = Boolean(model.series);
  $('#season-panel').hidden = !model.series || visible().length === 0;
  $('#empty-library').hidden = visible().length !== 0;
  const colors = ['#45513b', '#4b3f31', '#344c50', '#50414a', '#445541', '#4c4a34'];
  const initials = title => title.split(/\s+/).filter(w => !['that', 'time', 'as', 'a', 'of', 'the'].includes(w.toLowerCase())).slice(0, 2).map(w => w[0]).join('');
  $('#series-grid').innerHTML = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([series, files], index) => `<button class="series-card" data-series="${escape(series)}" aria-label="Browse ${escape(series)}" style="--card-color:${colors[index % colors.length]}"><div class="card-art"><span class="card-code">${escape(initials(series))}</span><span class="card-number">COLLECTION ${String(index + 1).padStart(2, '0')}</span><span class="card-arrow">↗</span></div><div class="card-details"><h2>${escape(series)}</h2><div class="card-meta"><span>${files.length} files · ${new Set(files.map(f => f.title)).size} entries</span><span>${bytes(files.reduce((a, f) => a + f.bytes, 0))}</span></div></div></button>`).join('');
  if (model.series) {
    $('#series-heading').textContent = model.series;
    const seasons = new Map();
    for (const file of visible()) { if (!seasons.has(file.title)) seasons.set(file.title, []); seasons.get(file.title).push(file); }
    $('#season-list').innerHTML = [...seasons].sort(([a], [b]) => a.localeCompare(b)).map(([title, files]) => `<div class="season-group"><div class="season-header"><h3>${escape(title)}</h3><small>${files.length} file${files.length === 1 ? '' : 's'}</small></div>${files.sort((a, b) => Number(a.episode) - Number(b.episode)).map(file => `<div class="episode-row"><label><input type="checkbox" data-file="${file.id}" ${model.selection.has(file.id) ? 'checked' : ''} aria-label="Select ${escape(file.filename)}"><span><span class="episode-label">${file.season === 'Movie' ? 'Movie' : `Episode ${escape(file.episode)}`}</span><span class="episode-info">${escape(file.season)} · ${file.quality ? `${file.quality}p` : 'Original'}</span></span></label><span class="episode-size">${bytes(file.bytes)}</span><a class="download-link" href="/api/files/${file.id}" download>↓ Download</a></div>`).join('')}</div>`).join('');
  }
  renderSelection();
}
function renderSelection() {
  const files = model.files.filter(f => model.selection.has(f.id));
  $('#selection-bar').hidden = !files.length || model.view !== 'library';
  $('#selection-count').textContent = `${files.length} file${files.length === 1 ? '' : 's'} selected`;
  $('#selection-size').textContent = `${bytes(files.reduce((sum, f) => sum + f.bytes, 0))} total`;
}
function renderQueue() {
  const pending = model.queue.filter(q => q.status !== 'downloaded');
  $('#queue-count').textContent = pending.length; $('#phone-queue-count').textContent = pending.length;
  $('#queue-summary').textContent = `${pending.length} pending · ${bytes(pending.reduce((sum, f) => sum + f.bytes - f.bytesCompleted, 0))} remaining`;
  $('#empty-queue').hidden = model.queue.length !== 0;
  $('#queue-list').innerHTML = [...model.queue].reverse().map(entry => `<div class="queue-row"><div class="queue-icon">${entry.status === 'downloaded' ? '✓' : '↘'}</div><div class="queue-detail"><strong>${escape(entry.filename)}</strong><small>${escape(entry.series)} · ${bytes(entry.bytes)}${entry.error ? ` · ${escape(entry.error)}` : ''}</small>${entry.status === 'downloading' ? `<div class="progress"><div style="width:${Math.min(100, entry.bytesCompleted / entry.bytes * 100)}%"></div></div>` : ''}</div><div class="queue-actions"><span class="queue-status">${escape(entry.status)}</span>${entry.status !== 'downloaded' ? `<a class="download-link" href="/api/files/${entry.fileId}" download>↓ Download</a>` : ''}<button class="text-button" data-remove="${entry.id}" ${entry.status === 'downloading' ? 'disabled' : ''} aria-label="Remove ${escape(entry.filename)} from queue">×</button></div></div>`).join('');
}
async function refresh() {
  const [library, queue] = await Promise.all([api('/library'), api('/queue')]);
  model.files = library.files; model.queue = queue;
  const known = new Set(model.files.map(f => f.id)); model.selection = new Set([...model.selection].filter(id => known.has(id)));
  $('#unavailable').hidden = !library.unavailable;
  $('#unavailable').textContent = `${library.unavailable} completion records are unavailable or have a size mismatch. They are excluded from transfers.`;
  $('#connection').className = 'connection online'; $('#connection').innerHTML = '<i></i> PC online';
  renderLibrary(); renderQueue();
  if (model.role === 'admin' && !preview) {
    const devices = await api('/devices');
    $('#device-status').textContent = devices.length ? `${devices[0].name} paired` : 'Ready to pair';
    $('#pair-button').innerHTML = devices.length ? 'Manage pairing <span>↗</span>' : 'Pair iPhone <span>↗</span>';
  }
}
async function boot() {
  try {
    try { await api('/local-session', { method: 'POST', body: '{}' }); } catch (error) { if (error.status !== 403) throw error; }
    const session = await api('/session'); model.role = session.role;
    $('#pair-gate').hidden = true; $('#workspace').hidden = false;
    $('#pair-button').hidden = session.role !== 'admin';
    $('#preview-note').hidden = !preview;
    await refresh(); model.ready = true;
  } catch (error) {
    if (error.status === 401) { $('#pair-gate').hidden = false; $('#workspace').hidden = true; $('#connection').innerHTML = '<i></i> Pair to connect'; }
    else { toast(error.message, true); $('#connection').className = 'connection offline'; $('#connection').innerHTML = '<i></i> PC unavailable'; }
  }
}
document.addEventListener('click', event => {
  const view = event.target.closest('[data-view]'); if (view) showView(view.dataset.view);
  const series = event.target.closest('[data-series]'); if (series) { model.series = series.dataset.series; renderLibrary(); }
  const remove = event.target.closest('[data-remove]'); if (remove) action(remove, async () => { await api(`/queue/${remove.dataset.remove}`, { method: 'DELETE' }); model.queue = await api('/queue'); renderQueue(); });
  if (event.target.closest('.download-link')) toast('Download requested. Your browser manages saving the file.');
});
$('#season-list').addEventListener('change', event => { const input = event.target.closest('[data-file]'); if (input) { input.checked ? model.selection.add(input.dataset.file) : model.selection.delete(input.dataset.file); renderSelection(); } });
$('#search').addEventListener('input', event => { model.query = event.target.value.trim().toLowerCase(); renderLibrary(); });
$('#back-button').addEventListener('click', () => { model.series = null; renderLibrary(); });
$('#select-visible').addEventListener('click', () => { visible().forEach(f => model.selection.add(f.id)); renderLibrary(); });
$('#clear-selection').addEventListener('click', () => { model.selection.clear(); renderLibrary(); });
$('#send-button').addEventListener('click', event => action(event.currentTarget, async () => { const count = model.selection.size; model.queue = await api('/queue', { method: 'POST', body: JSON.stringify({ fileIds: [...model.selection] }) }); model.selection.clear(); renderLibrary(); renderQueue(); toast(`${count} selected file${count === 1 ? '' : 's'} ready for iPhone pickup. Existing queued files are kept once.`); }));
$('#refresh-button').addEventListener('click', event => action(event.currentTarget, refresh));
$('#pair-button').addEventListener('click', event => action(event.currentTarget, async () => { const pairing = await api('/pairing', { method: 'POST', body: '{}' }); $('#generated-code').textContent = pairing.code; $('#code-expiry').textContent = `Expires at ${new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Use once within 10 minutes.`; $('#pair-dialog').showModal(); }));
$('#revoke-button').addEventListener('click', event => action(event.currentTarget, async () => { await api('/devices', { method: 'DELETE' }); $('#pair-dialog').close(); await refresh(); toast('Phone access revoked. Generate a new code to pair again.'); }));
$('#pair-form').addEventListener('submit', event => { event.preventDefault(); action($('#pair-form button'), async () => { await api('/pair', { method: 'POST', body: JSON.stringify({ code: $('#pair-code').value, name: 'Phone browser', client: 'browser' }) }); await boot(); }); });
let fetcherTitle = null, searchPage = 1, searchQuery = '', fetcherRefreshing = false;
async function refreshFetcher() {
  if (fetcherRefreshing) return;
  fetcherRefreshing = true;
  try {
    const state = await api('/download-jobs');
    $('#fetcher-status').textContent = state.blocked ? `Stopped: ${state.blocked.message}` : state.paused ? 'PC downloads paused' : `Fetcher online · ${state.active} active · ${state.jobs.filter(x => x.status === 'queued').length} queued`;
    $('#fetcher-jobs').innerHTML = state.jobs.map(job => `<div class="queue-row"><div class="queue-detail"><strong>${escape(job.title)} · Episode ${escape(job.episode)}</strong><small>${escape(job.phase || job.status)}${job.bytesReceived ? ` · ${bytes(job.bytesReceived)}` : ''}${job.speed ? ` · ${bytes(job.speed)}/s` : ''}${job.error ? ` · ${escape(job.error)}` : ''}</small></div><div class="queue-actions">${['failed', 'canceled'].includes(job.status) ? `<button class="text-button" data-fetcher-control="retry" data-job-id="${job.id}">Retry</button>` : ''}${job.status === 'queued' ? `<button class="text-button" data-fetcher-control="prioritize" data-job-id="${job.id}">First</button>` : ''}${['queued', 'downloading', 'failed'].includes(job.status) ? `<button class="text-button" data-fetcher-control="cancel" data-job-id="${job.id}">Cancel</button>` : ''}</div></div>`).join('') || '<p class="muted">No PC downloads queued.</p>';
  } catch (error) { $('#fetcher-status').textContent = error.message; }
  finally { fetcherRefreshing = false; }
}
async function searchAnime() {
  const result = await api(`/fetcher/search?q=${encodeURIComponent(searchQuery)}&page=${searchPage}`);
  $('#fetcher-results').innerHTML = result.items.map(item => `<div class="queue-row"><div class="queue-detail"><strong>${escape(item.title)}</strong><small>${escape(item.type)} · ${escape(item.year)} · ${escape(item.episodes)} episodes</small></div><button class="button subtle" data-fetcher-title="${escape(item.id)}">Episodes</button></div>`).join('') || '<p>No titles found. Try another name.</p>';
  if (result.hasMore) $('#fetcher-results').insertAdjacentHTML('beforeend', '<button id="fetcher-next" class="button subtle">Next results</button>');
}
$('#fetcher-search-form').addEventListener('submit', event => {
  event.preventDefault(); searchQuery = $('#fetcher-query').value.trim(); searchPage = 1;
  action(event.submitter, searchAnime);
});
document.addEventListener('click', event => {
  const title = event.target.closest('[data-fetcher-title]');
  if (title) action(title, async () => {
    const result = await api('/fetcher/titles/' + title.dataset.fetcherTitle);
    fetcherTitle = result;
    $('#fetcher-title').hidden = false; $('#fetcher-title-name').textContent = result.title; $('#fetcher-series').value = result.title;
    $('#fetcher-episodes').innerHTML = result.episodes.map(ep => `<label><input type="checkbox" value="${escape(ep.id)}" checked> Episode ${escape(ep.number)}</label>`).join('');
    $('#fetcher-title').scrollIntoView({ block: 'start' });
  });
  const control = event.target.closest('[data-fetcher-control]');
  if (control) action(control, async () => { await api('/download-jobs/control', { method: 'POST', body: JSON.stringify({ action: control.dataset.fetcherControl, id: control.dataset.jobId }) }); await refreshFetcher(); });
  if (event.target.closest('#fetcher-next')) action(event.target, async () => { searchPage++; try { await searchAnime(); } catch (error) { searchPage--; throw error; } });
});
$('#fetcher-select-all').addEventListener('click', () => { $('#fetcher-episodes').querySelectorAll('input').forEach(input => { input.checked = true; }); });
$('#fetcher-add').addEventListener('click', event => action(event.currentTarget, async () => {
  const episodeIds = [...$('#fetcher-episodes').querySelectorAll('input:checked')].map(x => x.value);
  if (!fetcherTitle || !episodeIds.length) throw new Error('Select at least one episode.');
  const result = await api('/download-jobs', { method: 'POST', body: JSON.stringify({ titleId: fetcherTitle.id, episodeIds, series: $('#fetcher-series').value }) });
  toast(`${result.added} queued · ${result.skipped} already in your collection or queue.`); await refreshFetcher();
}));
await boot();
setInterval(async () => {
  if (!model.ready || document.hidden) return;
  if (model.view === 'fetcher') void refreshFetcher();
  try { model.queue = await api('/queue'); renderQueue(); $('#connection').className = 'connection online'; $('#connection').innerHTML = '<i></i> PC online'; }
  catch (error) { $('#connection').className = 'connection offline'; $('#connection').innerHTML = '<i></i> PC unavailable'; if (error.status === 401) { model.ready = false; model.selection.clear(); model.files = []; model.queue = []; $('#workspace').hidden = true; $('#pair-gate').hidden = false; $('#selection-bar').hidden = true; } }
}, 5000);
