(() => {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  const state = { connection: {}, files: [], queue: [], transfers: [], drives: [], selection: new Set(), series: null, season: null, filter: 'all', search: '', tab: 'library', online: false, episode: null };
  const fetcher = { status: null, error: '', results: null, title: null, selection: new Set(), query: '', page: 1, notice: '' };
  let connectionEpoch = 0, fetcherRefresh, fetcherBusy = 0;
  let toastTimer, pendingConfirmation, refreshing = false;
  const markup = new Map();
  function setHTML(selector, html) { if (markup.get(selector) !== html) { $(selector).innerHTML = html; markup.set(selector, html); } }
  function dismissToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
  function toast(message, error = false) { $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6000); }
  async function action(button, task) { const pc = Boolean(button.closest('#fetcher-view')); if (pc) fetcherBusy++; button.disabled = true; if (pc) renderFetcher(); try { await task(); } catch (error) { toast(error.message, true); } finally { if (pc) fetcherBusy--; button.disabled = false; render(); } }
  function locations(file) { return file.locations || [{ kind: 'pc', label: 'On PC', available: true }]; }
  function visibleFiles() { return state.files.filter(file => (!state.series || file.series === state.series) && (!state.season || file.season === state.season) && (state.filter === 'all' || locations(file).some(source => source.kind === state.filter)) && `${file.series} ${file.title} ${file.season} ${file.filename}`.toLowerCase().includes(state.search)); }
  function badges(file) { return locations(file).map(source => `<span class="badge ${source.available ? '' : 'unavailable'}">${escape(source.label)}${source.available ? '' : source.kind === 'drive' ? ' · disconnected' : ' · unavailable'}</span>`).join(''); }
  function render() {
    const paired = state.connection.paired;
    $('#connection').textContent = state.connection.demo ? 'Demo data' : state.online ? 'PC online' : paired ? 'PC unavailable' : 'Not connected';
    $('#pair-view').hidden = paired || state.tab !== 'settings';
    for (const tab of ['library', 'queue', 'settings', 'fetcher']) $(`#${tab}-view`).hidden = tab !== state.tab;
    $('#downloaded-view').hidden = state.tab !== 'queue';
    document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === state.tab));
    $('#demo').hidden = !state.connection.canDemo;
    $('#platform-note').hidden = state.connection.platform !== 'windows-test' && !state.connection.demo;
    $('#platform-note').textContent = state.connection.demo ? 'Demo library — no file transfers.' : 'Windows test mode · Same app screens, generated files. Native iOS background behavior needs an iPhone test.';
    $('#pc-address').textContent = state.connection.server || 'No PC paired';
    $('#disconnect').disabled = !paired;
    $('#engine-note').textContent = state.connection.platform === 'windows-test' ? 'Windows tests use browser storage and HTTP ranges. iPhone uses native background transfers and app storage.' : 'iOS controls background scheduling. Force-quitting may interrupt transfers. Resume can restart if iOS cannot reuse saved resume data.';
    $('#library-summary').textContent = `${state.files.length} episodes · ${bytes(state.files.reduce((sum, file) => sum + file.bytes, 0))}`;
    $('#library-offline').hidden = state.online || !state.files.some(file => locations(file).some(source => source.kind === 'pc'));
    const files = visibleFiles(), groups = [...new Set(files.map(file => file.series))].sort();
    $('#series-list').hidden = Boolean(state.series);
    setHTML('#series-list', groups.map(series => `<button class="series" data-series="${escape(series)}" aria-label="Browse ${escape(series)}"><span class="series-icon">▦</span><span><strong>${escape(series)}</strong><small>${files.filter(file => file.series === series).length} episodes</small><span class="badges">${[...new Set(files.filter(file => file.series === series).flatMap(file => locations(file).map(source => source.kind)))].map(kind => `<span class="badge">${kind === 'phone' ? 'On iPhone' : kind === 'drive' ? 'On SSD' : 'On PC'}</span>`).join('')}</span></span></button>`).join(''));
    $('#episodes').hidden = !state.series;
    $('#series-name').textContent = state.season ? `${state.series} / ${state.season}` : state.series || '';
    $('#back').textContent = state.season ? '← All seasons' : '← All series';
    $('#season-list').hidden = Boolean(state.season);
    $('#episode-list').hidden = !state.season;
    const seasons = [...new Set(files.map(file => file.season || 'Unsorted'))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    setHTML('#season-list', seasons.map(season => `<button class="series" data-season="${escape(season)}" aria-label="Browse season ${escape(season)}"><span class="series-icon">▤</span><span><strong>${escape(season)}</strong><small>${files.filter(file => (file.season || 'Unsorted') === season).length} episodes</small></span></button>`).join(''));
    setHTML('#episode-list', files.sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.filename.localeCompare(b.filename, undefined, { numeric: true })).map(file => `<div class="episode"><input type="checkbox" id="pick-${escape(file.id)}" aria-label="Select ${escape(file.filename)}" data-file="${escape(file.id)}" ${state.selection.has(file.id) ? 'checked' : ''}><button class="episode-name" data-play="${escape(file.id)}" aria-label="Play ${escape(file.filename)}">${file.episode == null ? escape(file.filename) : `Episode ${escape(file.episode)}`}<small>${escape(file.title)} · ${bytes(file.bytes)}</small><span class="badges">${badges(file)}</span></button><button class="text" data-details="${escape(file.id)}" aria-label="Details for ${escape(file.filename)}">•••</button></div>`).join(''));
    $('#library-empty').hidden = files.length !== 0;
    $('#selection').hidden = state.tab !== 'library' || !state.selection.size;
    $('#selected-count').textContent = `${state.selection.size} selected`;
    $('#demo-warning').hidden = !state.connection.demo;
    $('#start').disabled = state.connection.demo || !state.queue.some(entry => !['downloaded'].includes(state.transfers.find(row => row.id === entry.id)?.status || entry.status));
    const destination = $('#destination').value;
    setHTML('#destination', '<option value="phone">iPhone storage</option>' + state.drives.filter(drive => drive.available).map(drive => `<option value="${escape(drive.id)}">SSD · ${escape(drive.name)}</option>`).join(''));
    if ([...$('#destination').options].some(option => option.value === destination)) $('#destination').value = destination;
    $('#destination-note').textContent = $('#destination').value === 'phone' ? 'iPhone downloads support background transfers.' : 'Direct SSD transfers · keep this app open and the drive connected. Partial files stay on the drive.';
    setHTML('#drive-list', state.drives.map(drive => `<div class="drive"><strong>${escape(drive.name)}</strong><span class="badge">${drive.available ? 'Connected' : 'Disconnected'}</span><button data-scan="${escape(drive.id)}" ${drive.available ? '' : 'disabled'}>Rescan</button></div>`).join('') || '<p class="muted small">Add a folder from a connected SSD or USB drive in Library.</p>');
    $('#queue-empty').hidden = state.queue.length !== 0;
    setHTML('#queue-list', state.queue.map(entry => {
      const local = state.transfers.find(row => row.id === entry.id), status = local?.status || entry.status;
      return `<div class="card" data-transfer="${escape(entry.id)}"><strong>${escape(entry.filename)}</strong><div class="meta"><span>${bytes(entry.bytes)} · ${escape(entry.destination || 'iPhone')}</span><span class="status">${escape(status)}</span></div>${local && ['downloading', 'paused', 'verifying'].includes(status) ? '<progress max="1" value="0" aria-label="Download progress"></progress>' : ''}${local?.error ? `<p class="muted small">${escape(local.error)}</p>` : ''}<div class="actions">${status === 'downloading' ? `<button data-command="pause" data-id="${escape(entry.id)}">Pause</button>` : ['paused', 'failed'].includes(status) ? `<button data-command="resume" data-id="${escape(entry.id)}">Resume</button>` : ''}</div></div>`;
    }).join(''));
    for (const card of $('#queue-list').querySelectorAll('[data-transfer]')) {
      const entry = state.queue.find(entry => entry.id === card.dataset.transfer);
      const progress = card.querySelector('progress');
      if (progress) progress.value = Math.min(1, (state.transfers.find(row => row.id === entry.id)?.received ?? entry.bytesCompleted) / entry.bytes);
    }
    const saved = state.transfers.filter(row => row.status === 'downloaded');
    $('#saved-summary').textContent = `${saved.length} files · ${bytes(saved.reduce((sum, row) => sum + row.bytes, 0))} saved`;
    $('#saved-empty').hidden = saved.length !== 0;
    setHTML('#saved-list', saved.map(row => `<div class="card" data-saved="${escape(row.id)}"><strong>${escape(row.filename)}</strong><p class="muted small">${bytes(row.bytes)} · ${row.verifiedSHA256 ? 'SHA-256 verified' : 'Verification unavailable'}</p>${row.canExport ? `<div class="actions"><button data-command="export" data-id="${escape(row.id)}">Export file</button><button class="danger" data-delete="${escape(row.id)}">Delete file</button></div>` : '<p class="muted small">File is no longer in app storage.</p>'}</div>`).join(''));
    renderFetcher();
  }
  function renderFetcher() {
    const disabled = !state.connection.paired || state.connection.demo || !fetcher.status || Boolean(fetcher.error) || fetcherBusy > 0;
    $('#fetcher-refresh').disabled = fetcherBusy > 0;
    $('#fetcher-status').textContent = state.connection.demo ? 'Demo — PC runner controls unavailable' : fetcher.error || (fetcher.status?.blocked ? `Stopped: ${fetcher.status.blocked.message}` : fetcher.status?.paused ? 'PC downloads paused' : fetcher.status ? `Runner online · ${fetcher.status.active} active · ${fetcher.status.jobs.filter(job => job.status === 'queued').length} queued` : 'Checking the PC runner…');
    for (const id of ['fetcher-search', 'fetcher-pause', 'fetcher-resume']) $(`#${id}`).disabled = disabled;
    $('#fetcher-notice').hidden = !fetcher.notice; $('#fetcher-notice').textContent = fetcher.notice;
    const results = fetcher.results;
    setHTML('#fetcher-results', results ? (results.items.map(item => `<div class="card"><strong>${escape(item.title)}</strong><p class="muted small">${escape([item.type, item.year, item.episodes == null ? '' : `${item.episodes} episodes`].filter(Boolean).join(' · '))}</p><button data-fetcher-title="${escape(item.id)}" ${disabled ? 'disabled' : ''}>Episodes</button></div>`).join('') || '<p class="empty">No titles found. Try another name.</p>') + (results.hasMore ? `<button id="fetcher-next" ${disabled ? 'disabled' : ''}>Next results</button>` : '') : '');
    $('#fetcher-title').hidden = !fetcher.title;
    $('#fetcher-title-name').textContent = fetcher.title?.title || '';
    $('#fetcher-selected').textContent = `${fetcher.selection.size} episodes selected`;
    $('#fetcher-add').disabled = disabled || !fetcher.selection.size;
    setHTML('#fetcher-episodes', (fetcher.title?.episodes || []).map(episode => `<div class="episode"><input id="fetch-${escape(episode.id)}" type="checkbox" data-fetcher-episode="${escape(episode.id)}" ${fetcher.selection.has(episode.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}><label for="fetch-${escape(episode.id)}">Episode ${escape(episode.number)}</label></div>`).join(''));
    setHTML('#fetcher-jobs', (fetcher.status?.jobs || []).map(job => `<div class="card" data-pc-job="${escape(job.id)}"><strong>${escape(job.title)} · Episode ${escape(job.episode)}</strong><p class="muted small">${escape(job.phase || job.status)}${job.bytesReceived ? ` · ${bytes(job.bytesReceived)} received` : ''}${job.speed ? ` · ${bytes(job.speed)}/s` : ''}</p>${job.error ? `<p class="muted small">${escape(job.error)}</p>` : ''}<div class="actions">${['failed', 'canceled'].includes(job.status) ? `<button data-fetcher-action="retry" data-job="${escape(job.id)}" ${disabled ? 'disabled' : ''}>Retry PC download</button>` : ''}${job.status === 'queued' ? `<button data-fetcher-action="prioritize" data-job="${escape(job.id)}" ${disabled ? 'disabled' : ''}>Download first</button>` : ''}${['queued', 'downloading', 'failed'].includes(job.status) ? `<button data-fetcher-action="cancel" data-job="${escape(job.id)}" ${disabled ? 'disabled' : ''}>Cancel PC download</button>` : ''}</div></div>`).join('') || '<p class="empty">No PC downloads queued</p>');
  }
  function resetFetcher() { connectionEpoch++; fetcher.status = null; fetcher.error = ''; fetcher.results = null; fetcher.title = null; fetcher.selection.clear(); fetcher.notice = ''; fetcher.query = ''; $('#fetcher-query').value = ''; }
  async function refreshFetcher() {
    if (!state.connection.paired || state.connection.demo) { renderFetcher(); return; }
    if (fetcherRefresh) return fetcherRefresh;
    const epoch = connectionEpoch;
    fetcherRefresh = (async () => {
      try { const status = await Hub.call('fetcherStatus'); if (epoch === connectionEpoch) { fetcher.status = status; fetcher.error = ''; } }
      catch (error) { if (epoch === connectionEpoch) fetcher.error = error.message; }
      finally { if (epoch === connectionEpoch) renderFetcher(); }
    })();
    try { await fetcherRefresh; } finally { fetcherRefresh = null; }
  }
  async function searchFetcher(page = 1) {
    const epoch = connectionEpoch, query = fetcher.query;
    const results = await Hub.call('fetcherSearch', { query, page });
    if (epoch !== connectionEpoch) return;
    fetcher.results = results; fetcher.page = page; fetcher.title = null; fetcher.selection.clear(); fetcher.notice = ''; renderFetcher();
  }
  function switchTab(tab) { state.tab = tab; render(); window.scrollTo(0, 0); if (tab === 'fetcher') void refreshFetcher(); }
  let savedRevision = '';
  async function refreshTransfers() { state.transfers = await Hub.call('transfers'); state.queue = await Hub.call('queue'); const revision = state.transfers.filter(row => row.status === 'downloaded').map(row => row.id).join('|'); if (revision !== savedRevision) { savedRevision = revision; state.files = await Hub.call('library'); } render(); }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state.connection = await Hub.call('connection');
      state.files = await Hub.call('library');
      await refreshTransfers();
      state.drives = await Hub.call('drives');
      const ids = new Set(state.files.map(file => file.id)); state.selection = new Set([...state.selection].filter(id => ids.has(id)));
      render();
    } finally { refreshing = false; }
  }
  let syncing;
  async function syncPC() {
    if (syncing) return syncing;
    syncing = (async () => {
      try { const result = await Hub.call('refreshCatalog'); state.online = result.online; await refresh(); }
      catch { state.online = false; render(); }
    })();
    try { await syncing; } finally { syncing = null; }
  }
  function confirm(title, text, task) { pendingConfirmation = task; $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('#confirm-dialog').showModal(); }
  $('#pair-form').addEventListener('submit', event => { event.preventDefault(); action($('#connect'), async () => { await Hub.call('pair', { server: $('#server').value.trim(), code: $('#code').value }); resetFetcher(); dismissToast(); await syncPC(); switchTab('library'); }); });
  $('#refresh').addEventListener('click', event => action(event.currentTarget, syncPC));
  $('#search').addEventListener('input', event => { state.search = event.target.value.trim().toLowerCase(); render(); });
  $('#back').addEventListener('click', () => { if (state.season) state.season = null; else state.series = null; render(); });
  $('#select-all').addEventListener('click', () => { visibleFiles().forEach(file => state.selection.add(file.id)); render(); });
  $('#clear').addEventListener('click', () => { state.selection.clear(); render(); });
  $('#add').addEventListener('click', event => action(event.currentTarget, async () => { state.queue = await Hub.call('addQueue', { fileIds: [...state.selection], destination: $('#destination').value }); state.selection.clear(); switchTab('queue'); }));
  $('#start').addEventListener('click', event => action(event.currentTarget, async () => { await Hub.call('start'); await refreshTransfers(); }));
  $('#demo').addEventListener('click', event => action(event.currentTarget, async () => { await Hub.call('demo'); resetFetcher(); await refresh(); }));
  $('#disconnect').addEventListener('click', () => confirm('Disconnect PC?', 'Transfers pause. Your library and saved files stay available. PC downloads keep running.', async () => { await Hub.call('disconnect'); state.online = false; resetFetcher(); await refresh(); switchTab('library'); }));
  $('#library-filter').addEventListener('change', event => { state.filter = event.target.value; state.series = state.season = null; render(); });
  $('#destination').addEventListener('change', render);
  for (const [id, method] of [['add-folder', 'addFolder'], ['import-files', 'importFiles']]) $( '#' + id).addEventListener('click', event => action(event.currentTarget, async () => { const result = await Hub.call(method); await refresh(); toast(`${result.count} episodes ${method === 'addFolder' ? 'indexed' : 'imported'}`); }));
  function showDetails(id) {
    const file = state.files.find(file => file.id === id); if (!file) return;
    state.episode = id;
    $('#episode-title').textContent = file.episode == null ? file.filename : `Episode ${file.episode}`;
    $('#episode-info').textContent = `${file.filename} · ${bytes(file.bytes)} · ${file.series} / ${file.season}`;
    $('#episode-locations').innerHTML = badges(file);
    const local = locations(file).some(source => source.kind !== 'pc' && source.available);
    $('#episode-play').disabled = $('#episode-export').disabled = !local;
    $('#episode-import').hidden = !locations(file).some(source => source.kind === 'drive' && source.available) || locations(file).some(source => source.kind === 'phone' && source.available);
    $('#episode-download').hidden = !locations(file).some(source => source.kind === 'pc');
    $('#episode-delete').hidden = !locations(file).some(source => source.kind === 'phone' && source.available);
    $('#organize-series').value = file.series; $('#organize-season').value = file.season; $('#organize-episode').value = file.episode ?? '';
    $('#episode-dialog').showModal();
  }
  $('#episode-close').addEventListener('click', () => $('#episode-dialog').close());
  for (const [id, method] of [['episode-play', 'play'], ['episode-import', 'importEpisode'], ['episode-export', 'exportEpisode']]) $('#' + id).addEventListener('click', event => action(event.currentTarget, async () => { const episodeID = state.episode; $('#episode-dialog').close(); await Hub.call(method, { id: episodeID }); await refresh(); }));
  $('#episode-download').addEventListener('click', event => action(event.currentTarget, async () => { const id = state.episode; $('#episode-dialog').close(); await Hub.call('addQueue', { fileIds: [id], destination: $('#destination').value }); await refresh(); switchTab('queue'); }));
  $('#episode-delete').addEventListener('click', () => { const id = state.episode; $('#episode-dialog').close(); confirm('Delete iPhone copy?', 'The PC and SSD copies will stay untouched.', async () => { await Hub.call('deleteEpisode', { id }); await refresh(); }); });
  $('#organize-form').addEventListener('submit', event => { event.preventDefault(); action(event.currentTarget.querySelector('button'), async () => { await Hub.call('organize', { id: state.episode, series: $('#organize-series').value.trim(), season: $('#organize-season').value.trim(), episode: $('#organize-episode').value === '' ? null : Number($('#organize-episode').value) }); $('#episode-dialog').close(); state.series = state.season = null; await refresh(); }); });
  $('#fetcher-refresh').addEventListener('click', event => action(event.currentTarget, refreshFetcher));
  $('#fetcher-search-form').addEventListener('submit', event => { event.preventDefault(); fetcher.query = $('#fetcher-query').value.trim(); action($('#fetcher-search'), () => searchFetcher()); });
  $('#fetcher-select-all').addEventListener('click', () => { fetcher.title?.episodes.forEach(episode => fetcher.selection.add(episode.id)); renderFetcher(); });
  $('#fetcher-add').addEventListener('click', event => action(event.currentTarget, async () => {
    if (!fetcher.title || !fetcher.selection.size) throw new Error('Select episodes first.');
    const epoch = connectionEpoch;
    const result = await Hub.call('fetcherAdd', { titleId: fetcher.title.id, episodeIds: [...fetcher.selection], series: $('#fetcher-series').value.trim() });
    if (epoch !== connectionEpoch) return;
    fetcher.notice = `${result.added} episodes queued on PC · ${result.skipped} already queued or saved`; fetcher.selection.clear(); await refreshFetcher();
  }));
  $('#confirm-cancel').addEventListener('click', () => { pendingConfirmation = null; $('#confirm-dialog').close(); });
  $('#confirm-yes').addEventListener('click', event => action(event.currentTarget, async () => { const task = pendingConfirmation; pendingConfirmation = null; $('#confirm-dialog').close(); await task?.(); }));
  document.addEventListener('change', event => { if (event.target.dataset.file) { event.target.checked ? state.selection.add(event.target.dataset.file) : state.selection.delete(event.target.dataset.file); render(); } if (event.target.dataset.fetcherEpisode) { event.target.checked ? fetcher.selection.add(event.target.dataset.fetcherEpisode) : fetcher.selection.delete(event.target.dataset.fetcherEpisode); renderFetcher(); } });
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]'); if (tab) switchTab(tab.dataset.tab);
    const series = event.target.closest('[data-series]'); if (series) { state.series = series.dataset.series; state.season = null; render(); }
    const season = event.target.closest('[data-season]'); if (season) { state.season = season.dataset.season; render(); }
    const details = event.target.closest('[data-details]'); if (details) showDetails(details.dataset.details);
    const playing = event.target.closest('[data-play]'); if (playing) { const file = state.files.find(file => file.id === playing.dataset.play); if (file && locations(file).some(source => source.kind !== 'pc' && source.available)) action(playing, () => Hub.call('play', { id: file.id })); else showDetails(playing.dataset.play); }
    const scan = event.target.closest('[data-scan]'); if (scan) action(scan, async () => { const result = await Hub.call('scanDrive', { id: scan.dataset.scan }); await refresh(); toast(`${result.count} episodes indexed`); });
    const command = event.target.closest('[data-command]'); if (command) action(command, async () => { await Hub.call(command.dataset.command, { id: command.dataset.id }); await refreshTransfers(); });
    const deleting = event.target.closest('[data-delete]'); if (deleting) confirm('Delete downloaded file?', 'This removes the saved copy from this device. The original stays on your PC.', async () => { await Hub.call('delete', { id: deleting.dataset.delete }); await refreshTransfers(); });
    const title = event.target.closest('[data-fetcher-title]'); if (title) action(title, async () => { const epoch = connectionEpoch; const value = await Hub.call('fetcherTitle', { id: title.dataset.fetcherTitle }); if (epoch !== connectionEpoch) return; fetcher.title = value; fetcher.selection = new Set(value.episodes.map(episode => episode.id)); $('#fetcher-series').value = value.title; renderFetcher(); $('#fetcher-title').scrollIntoView({ block: 'start' }); });
    const next = event.target.closest('#fetcher-next'); if (next) action(next, () => searchFetcher(fetcher.page + 1));
    const control = event.target.closest('[data-fetcher-action]'); if (control) {
      const params = { action: control.dataset.fetcherAction, id: control.dataset.job };
      const task = async () => { await Hub.call('fetcherControl', params); await refreshFetcher(); };
      if (params.action === 'cancel') confirm('Cancel PC download?', 'This stops this PC job. You can retry it later. Phone transfers are unaffected.', task);
      else action(control, task);
    }
  });
  window.addEventListener('hub-transfer-update', () => refreshTransfers().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh().catch(error => toast(error.message, true)); if (state.tab === 'fetcher') void refreshFetcher(); } });
  async function boot() {
    try { await refresh(); $('#server').value = state.connection.testServer || state.connection.server || ''; $('#code').value = state.connection.testCode || ''; void syncPC(); }
    catch (error) { toast(error.message, true); render(); }
  }
  boot();
  setInterval(() => { if (!document.hidden) refreshTransfers().catch(() => {}); }, 1000);
  setInterval(() => { if (!document.hidden && state.connection.paired) void syncPC(); }, 30000);
  setInterval(() => { if (!document.hidden && state.tab === 'fetcher') void refreshFetcher(); }, 4000);
})();
