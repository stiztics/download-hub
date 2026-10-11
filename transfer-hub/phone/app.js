(() => {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${(value / 1e6).toFixed(1)} MB`;
  const state = { connection: {}, files: [], queue: [], transfers: [], selection: new Set(), series: null, search: '', tab: 'library', online: false };
  const fetcher = { status: null, error: '', results: null, title: null, selection: new Set(), query: '', page: 1, notice: '' };
  let connectionEpoch = 0, fetcherRefresh, fetcherBusy = 0;
  let toastTimer, pendingConfirmation, refreshing = false;
  const markup = new Map();
  function setHTML(selector, html) { if (markup.get(selector) !== html) { $(selector).innerHTML = html; markup.set(selector, html); } }
  function dismissToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
  function toast(message, error = false) { $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6000); }
  async function action(button, task) { const pc = Boolean(button.closest('#fetcher-view')); if (pc) fetcherBusy++; button.disabled = true; if (pc) renderFetcher(); try { await task(); } catch (error) { toast(error.message, true); } finally { if (pc) fetcherBusy--; button.disabled = false; render(); } }
  function visibleFiles() { return state.files.filter(file => (!state.series || file.series === state.series) && `${file.series} ${file.title} ${file.filename}`.toLowerCase().includes(state.search)); }
  function render() {
    const paired = state.connection.paired;
    $('#connection').textContent = state.connection.demo ? 'Demo data' : state.online ? 'PC online' : paired ? 'PC unavailable' : 'Not connected';
    $('#pair-view').hidden = paired || !['library', 'queue', 'fetcher'].includes(state.tab);
    for (const tab of ['library', 'queue', 'downloaded', 'settings', 'fetcher']) $(`#${tab}-view`).hidden = tab !== state.tab || (!paired && ['library', 'queue', 'fetcher'].includes(tab));
    document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === state.tab));
    $('#demo').hidden = !state.connection.canDemo;
    $('#platform-note').hidden = state.connection.platform !== 'windows-test' && !state.connection.demo;
    $('#platform-note').textContent = state.connection.demo ? 'Demo library — no file transfers.' : 'Windows test mode · Same app screens, generated files. Native iOS background behavior needs an iPhone test.';
    $('#pc-address').textContent = state.connection.server || 'No PC paired';
    $('#disconnect').disabled = !paired;
    $('#engine-note').textContent = state.connection.platform === 'windows-test' ? 'Windows tests use browser storage and HTTP ranges. iPhone uses native background transfers and app storage.' : 'iOS controls background scheduling. Force-quitting may interrupt transfers. Resume can restart if iOS cannot reuse saved resume data.';
    $('#library-summary').textContent = `${state.files.length} completed files · ${bytes(state.files.reduce((sum, file) => sum + file.bytes, 0))}`;
    const files = visibleFiles(), groups = [...new Set(files.map(file => file.series))].sort();
    $('#series-list').hidden = Boolean(state.series);
    setHTML('#series-list', groups.map(series => `<button class="series" data-series="${escape(series)}" aria-label="Browse ${escape(series)}"><span class="series-icon">▦</span><span><strong>${escape(series)}</strong><small>${files.filter(file => file.series === series).length} files</small></span></button>`).join(''));
    $('#episodes').hidden = !state.series;
    $('#series-name').textContent = state.series || '';
    setHTML('#episode-list', files.sort((a, b) => Number(a.episode) - Number(b.episode)).map(file => `<div class="episode"><input type="checkbox" id="pick-${escape(file.id)}" data-file="${escape(file.id)}" ${state.selection.has(file.id) ? 'checked' : ''}><label for="pick-${escape(file.id)}">${file.season === 'Movie' ? 'Movie' : `Episode ${escape(file.episode ?? '—')}`}<small>${escape(file.title)} · ${escape(file.season)}</small></label><span>${bytes(file.bytes)}</span></div>`).join(''));
    $('#library-empty').hidden = files.length !== 0;
    $('#selection').hidden = !paired || state.tab !== 'library' || !state.selection.size;
    $('#selected-count').textContent = `${state.selection.size} selected`;
    $('#demo-warning').hidden = !state.connection.demo;
    $('#start').disabled = state.connection.demo || !state.queue.some(entry => !['downloaded'].includes(state.transfers.find(row => row.id === entry.id)?.status || entry.status));
    $('#queue-empty').hidden = state.queue.length !== 0;
    setHTML('#queue-list', state.queue.map(entry => {
      const local = state.transfers.find(row => row.id === entry.id), status = local?.status || entry.status;
      return `<div class="card" data-transfer="${escape(entry.id)}"><strong>${escape(entry.filename)}</strong><div class="meta"><span>${bytes(entry.bytes)}</span><span class="status">${escape(status)}</span></div>${local && ['downloading', 'paused', 'verifying'].includes(status) ? '<progress max="1" value="0" aria-label="Download progress"></progress>' : ''}${local?.error ? `<p class="muted small">${escape(local.error)}</p>` : ''}<div class="actions">${status === 'downloading' ? `<button data-command="pause" data-id="${escape(entry.id)}">Pause</button>` : ['paused', 'failed'].includes(status) ? `<button data-command="resume" data-id="${escape(entry.id)}">Resume</button>` : ''}</div></div>`;
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
  async function refreshTransfers() { state.transfers = await Hub.call('transfers'); render(); }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state.connection = await Hub.call('connection');
      await refreshTransfers();
      if (state.connection.paired) {
        try {
          const [library, queue] = await Promise.all([Hub.call('library'), Hub.call('queue')]);
          state.files = library; state.queue = queue; state.online = !state.connection.demo;
          const ids = new Set(library.map(file => file.id)); state.selection = new Set([...state.selection].filter(id => ids.has(id)));
        } catch (error) { state.online = false; toast(error.message, true); }
      } else { state.files = []; state.queue = []; state.online = false; }
      render();
    } finally { refreshing = false; }
  }
  function confirm(title, text, task) { pendingConfirmation = task; $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('#confirm-dialog').showModal(); }
  $('#pair-form').addEventListener('submit', event => { event.preventDefault(); action($('#connect'), async () => { await Hub.call('pair', { server: $('#server').value.trim(), code: $('#code').value }); resetFetcher(); dismissToast(); await refresh(); if (state.tab === 'fetcher') await refreshFetcher(); }); });
  $('#refresh').addEventListener('click', event => action(event.currentTarget, refresh));
  $('#search').addEventListener('input', event => { state.search = event.target.value.trim().toLowerCase(); render(); });
  $('#back').addEventListener('click', () => { state.series = null; render(); });
  $('#select-all').addEventListener('click', () => { visibleFiles().forEach(file => state.selection.add(file.id)); render(); });
  $('#clear').addEventListener('click', () => { state.selection.clear(); render(); });
  $('#add').addEventListener('click', event => action(event.currentTarget, async () => { state.queue = await Hub.call('addQueue', { fileIds: [...state.selection] }); state.selection.clear(); switchTab('queue'); }));
  $('#start').addEventListener('click', event => action(event.currentTarget, async () => { await Hub.call('start'); await refreshTransfers(); }));
  $('#demo').addEventListener('click', event => action(event.currentTarget, async () => { await Hub.call('demo'); resetFetcher(); await refresh(); }));
  $('#disconnect').addEventListener('click', () => confirm('Disconnect PC?', 'Phone transfers pause. Saved files stay on this device. PC downloads keep running.', async () => { await Hub.call('disconnect'); resetFetcher(); state.selection.clear(); state.series = null; state.search = ''; $('#search').value = ''; await refresh(); switchTab('library'); }));
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
    const series = event.target.closest('[data-series]'); if (series) { state.series = series.dataset.series; render(); }
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
    try { await refresh(); $('#server').value = state.connection.testServer || state.connection.server || ''; $('#code').value = state.connection.testCode || ''; }
    catch (error) { toast(error.message, true); render(); }
  }
  boot();
  setInterval(() => { if (!document.hidden) refreshTransfers().catch(() => {}); }, 700);
  setInterval(() => { if (!document.hidden && state.connection.paired) refresh().catch(() => {}); }, 15000);
  setInterval(() => { if (!document.hidden && state.tab === 'fetcher') void refreshFetcher(); }, 4000);
})();
