// Served ONLY by the generated-file fixture, never by the real collection service.
// This implements the native bridge contract for free Windows UI/transfer tests.
// Browser storage is a test substitute for iOS app storage and background tasks.
(() => {
  let credentials = JSON.parse(sessionStorage.getItem('hub-test-connection') || 'null');
  let demo = false, demoQueue = [];
  let catalog = JSON.parse(localStorage.getItem('hub-test-catalog') || '[]');
  const titles = new Map();
  let requests = JSON.parse(localStorage.getItem('hub-test-requests') || '[]');
  const rememberRequests = () => localStorage.setItem('hub-test-requests', JSON.stringify(requests));
  const driveState = JSON.parse(localStorage.getItem('hub-test-drives') || '[]');
  const rememberCatalog = () => localStorage.setItem('hub-test-catalog', JSON.stringify(catalog));
  function snapshot() {
    for (const row of rows.values()) if (row.status === 'downloaded' && row.verifiedSHA256) {
      let file = catalog.find(file => file.id === row.fileId);
      if (!file) { file = { ...(row.entry || {}), id: row.fileId, season: 'Unsorted', episode: null, filename: row.filename, bytes: row.bytes, locations: [] }; catalog.push(file); }
      const id = 'phone:' + row.id;
      if (!file.locations.some(source => source.id === id)) file.locations.push({ id, kind: 'phone', label: 'On iPhone', available: true, transferId: row.id });
    }
    rememberCatalog(); return structuredClone(catalog);
  }
  const rows = new Map(), jobs = new Map();
  let writes = Promise.resolve();
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('download-hub-windows-test', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('transfers', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transaction(mode, task) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('transfers', mode);
      const request = task(tx.objectStore('transfers'));
      let value;
      if (request) request.onsuccess = () => value = request.result;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage operation failed.'));
    });
  }
  const loaded = transaction('readonly', store => store.getAll()).then(saved => {
    for (const row of saved) {
      if (['downloading', 'verifying', 'queued'].includes(row.status)) row.status = 'paused';
      rows.set(row.id, row);
    }
  });
  function save(row) {
    const snapshot = structuredClone(row);
    const next = writes.then(() => transaction('readwrite', store => store.put(snapshot)));
    writes = next.catch(() => {});
    return next;
  }
  function notify() { window.dispatchEvent(new Event('hub-transfer-update')); }
  function connection() { return { paired: Boolean(credentials) || demo, server: demo ? 'Demo library' : credentials?.server || '', platform: 'windows-test', demo, canDemo: true }; }
  function transfers() {
    if (demo) return [];
    return [...rows.values()].filter(row => !row.imported).map(({ chunks, expectedSHA256, etag, entry, ...row }) => ({ ...row, canExport: row.status === 'downloaded' && row.received === row.bytes && Boolean(row.verifiedSHA256) }));
  }
  async function api(route, method = 'GET', body, extra = {}) {
    if (!credentials) throw new Error('Connect your PC first.');
    const response = await fetch('/api/' + route, { method, headers: { Authorization: 'Bearer ' + credentials.token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra.headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...(extra.signal ? { signal: extra.signal } : {}) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'PC request failed.');
    }
    return response;
  }
  async function report(row) {
    if (row.entry?.clientOwned) return;
    const body = { status: row.status === 'verifying' ? 'downloading' : row.status, bytesCompleted: row.received, reportedAt: Date.now(), ...(row.error ? { error: row.error } : {}) };
    await api('queue/' + row.id, 'PATCH', body);
  }
  async function run(row, signal) {
    try {
      if (row.bytes > 16 * 1024 * 1024) throw new Error('Windows test mode supports generated files up to 16 MiB.');
      const checksum = await (await api('files/' + row.fileId + '/checksum')).json();
      const head = await api('files/' + row.fileId, 'HEAD');
      if (Number(head.headers.get('content-length')) !== row.bytes || checksum.bytes !== row.bytes) throw new Error('The file changed. Refresh the library.');
      const etag = head.headers.get('etag');
      if (row.etag && row.etag !== etag) { row.received = 0; row.chunks = []; }
      row.etag = etag; row.expectedSHA256 = checksum.sha256;
      if (signal.aborted) return;
      await report(row);
      while (row.received < row.bytes && !signal.aborted) {
        const start = row.received, end = Math.min(row.bytes - 1, start + 65535);
        const response = await api('files/' + row.fileId, 'GET', null, { headers: { Range: `bytes=${start}-${end}`, 'If-Range': row.etag }, signal });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${row.bytes}`) throw new Error('The PC refused a resumed range. Retry the transfer.');
        const chunk = await response.arrayBuffer();
        if (chunk.byteLength !== end - start + 1) throw new Error('Incomplete range received.');
        if (signal.aborted) return;
        row.chunks.push(chunk); row.received += chunk.byteLength;
        await save(row); notify();
        // Deliberate pacing in the test adapter makes pause/resume reproducible.
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (signal.aborted) return;
      row.status = 'verifying'; notify();
      const file = new Blob(row.chunks), data = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (signal.aborted) return;
      if (file.size !== row.bytes || hash !== row.expectedSHA256) throw new Error('Checksum verification failed. Retry the transfer.');
      row.status = 'downloaded'; row.verifiedSHA256 = hash; row.error = '';
      await save(row); await report(row).catch(() => {}); notify();
    } catch (error) {
      if (signal.aborted) return;
      row.status = 'failed'; row.error = error.message;
      await save(row); await report(row).catch(() => {}); notify();
    }
  }
  function pump() {
    if (!credentials || demo) return;
    for (const row of rows.values()) {
      if (jobs.size >= 2) break;
      if (row.status !== 'queued' || jobs.has(row.id)) continue;
      row.status = 'downloading'; row.error = '';
      const controller = new AbortController();
      const job = { controller, done: null };
      jobs.set(row.id, job);
      job.done = run(row, controller.signal).finally(() => { jobs.delete(row.id); notify(); pump(); });
    }
    notify();
  }
  function getRow(id) { const row = rows.get(id); if (!row) throw new Error('Transfer not found.'); return row; }
  async function pause(id) {
    const row = getRow(id), job = jobs.get(id);
    row.status = 'paused';
    job?.controller.abort();
    if (job) await job.done;
    await save(row); await report(row).catch(() => {}); notify();
  }
  // Synthetic bulk copies exercise the UI contract and real generated bytes.
  // Physical USB providers and file coordination are tested by the Swift suite.
  let bulk = JSON.parse(localStorage.getItem('hub-test-bulk') || 'null'), bulkRunning = false, bulkCanceled = false;
  if (bulk && ['running', 'canceling'].includes(bulk.status)) { bulk.status = 'interrupted'; bulk.error = 'The app closed. Retry continues with unfinished files.'; }
  const saveBulk = () => localStorage.setItem('hub-test-bulk', JSON.stringify(bulk));
  const bulkDone = item => ['copied', 'skipped', 'moved'].includes(item.status);
  function bulkStatus() {
    if (!bulk) return { status: 'idle', active: false };
    const done = bulk.items.filter(bulkDone);
    return { ...bulk, items: undefined, total: bulk.items.length, completed: done.length, active: bulkRunning,
      copied: done.filter(item => item.status === 'copied').length, skipped: done.filter(item => item.status === 'skipped').length, moved: done.filter(item => item.status === 'moved').length,
      failed: bulk.items.filter(item => item.status === 'failed').length, bytes: bulk.items.reduce((sum, item) => sum + item.file.bytes, 0), received: done.reduce((sum, item) => sum + item.file.bytes, 0) + (bulk.currentBytes || 0),
      errors: bulk.items.filter(item => item.status === 'failed').map(item => ({ filename: item.file.filename, error: item.error })), speed: 0 };
  }
  const hashBytes = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  async function runBulk() {
    bulkRunning = true; bulkCanceled = false; bulk.status = 'running'; bulk.error = ''; saveBulk();
    try {
      for (const item of bulk.items) {
        if (bulkDone(item)) continue;
        if (bulkCanceled) throw new Error('Canceled');
        const file = catalog.find(file => file.id === item.file.id);
        bulk.filename = item.file.filename; bulk.phase = 'copying'; bulk.currentBytes = 0;
        try {
          if (window.__externalFolderFixture?.available === false) throw new Error('The drive disconnected. Reconnect it and retry.');
          if (!file || item.file.bytes > 16 * 1024 * 1024) throw new Error('Generated Windows bulk fixtures are limited to 16 MiB per file.');
          let data;
          if (bulk.direction === 'import' && !item.existingSource) {
            const source = window.__externalFolderFixture.files.find(source => source.id === file.id);
            if (!source) throw new Error('Source file unavailable.');
            data = new Uint8Array(file.bytes);
            const seed = [...file.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
            for (let index = 0; index < data.length; index++) data[index] = (seed + index) % 251;
          } else {
            const row = rows.get(item.existingSource?.transferId || item.source.transferId);
            if (!row) throw new Error('Saved file unavailable.');
            data = new Uint8Array(await new Blob(row.chunks).arrayBuffer());
          }
          const copy = new Uint8Array(data.length);
          for (let offset = 0; offset < data.length; offset += 65536) {
            if (bulkCanceled) throw new Error('Canceled');
            if (window.__externalFolderFixture?.available === false) throw new Error('The drive disconnected. Reconnect it and retry.');
            copy.set(data.subarray(offset, offset + 65536), offset); bulk.currentBytes = Math.min(data.length, offset + 65536); saveBulk();
            await new Promise(resolve => setTimeout(resolve, window.__bulkCopyDelay || 25));
          }
          bulk.phase = 'verifying';
          const checksum = await hashBytes(data);
          if (checksum !== await hashBytes(copy) || item.source.checksum && checksum !== item.source.checksum) throw new Error('Copy verification failed. Original preserved.');
          if (bulkCanceled) throw new Error('Canceled');
          const collision = window.__externalFolderFixture?.existing?.[file.filename];
          if (bulk.direction === 'export' && collision && collision !== checksum) throw new Error('A different file already exists at this destination. It was preserved.');
          if (bulk.direction === 'import' && !item.existingSource) {
            const id = 'bulk-' + crypto.randomUUID();
            const row = { id, fileId: file.id, filename: file.filename, bytes: file.bytes, status: 'downloaded', received: file.bytes, chunks: [copy.buffer], verifiedSHA256: checksum, imported: true, entry: { ...item.file, clientOwned: true } };
            rows.set(id, row); await save(row);
            file.locations.push({ id: 'phone:' + id, kind: 'phone', label: 'On iPhone', available: true, transferId: id, checksum });
          } else if (bulk.direction === 'export' && !file.locations.some(source => source.kind === 'drive' && source.driveID === bulk.driveID)) {
            file.locations.push({ id: 'drive:' + bulk.driveID + ':' + file.id, kind: 'drive', label: 'On SSD · ' + window.__externalFolderFixture.name, available: true, driveID: bulk.driveID, checksum });
          }
          if (bulk.removeOriginals) {
            if (bulk.direction === 'export') { await transaction('readwrite', store => store.delete(item.source.transferId)); rows.delete(item.source.transferId); }
            file.locations = file.locations.filter(source => source.id !== item.source.id);
            item.status = 'moved';
          } else item.status = collision || item.existingSource ? 'skipped' : 'copied';
          rememberCatalog();
        } catch (error) {
          if (bulkCanceled) { item.status = 'pending'; throw error; }
          item.status = 'failed'; item.error = error.message;
          if (window.__externalFolderFixture?.available === false) throw error;
        }
        saveBulk();
      }
      bulk.status = bulk.items.some(item => item.status === 'failed') ? 'completed with errors' : 'completed';
    } catch (error) { bulk.status = bulkCanceled ? 'canceled' : 'interrupted'; bulk.error = error.message; }
    finally { bulk.currentBytes = 0; bulk.filename = ''; bulk.phase = ''; bulkRunning = false; saveBulk(); notify(); }
  }
  const demoFiles = [1, 2].map(episode => ({ id: 'demo-' + episode, series: 'Demo Series', title: 'Test Season', season: 'S01', episode, filename: `Demo Episode ${episode}.bin`, bytes: 2097152, quality: null }));
  window.WindowsHubHost = {
    async call(method, params = {}) {
      await loaded;
      switch (method) {
        case 'connection': return connection();
        case 'pair': {
          if (new URL(params.server).origin !== location.origin || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Windows test mode connects only to this generated-file fixture.');
          if (!/^\d{8}$/.test(params.code)) throw new Error('Enter the eight-digit pairing code.');
          const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: params.code, name: 'Windows test phone', client: 'ios' }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          credentials = { server: location.origin, token: result.token }; demo = false;
          sessionStorage.setItem('hub-test-connection', JSON.stringify(credentials));
          return connection();
        }
        case 'library': return demo ? demoFiles : snapshot();
        case 'bulkStatus': return bulkStatus();
        case 'prepareBulk': {
          if (bulkRunning) throw new Error('Finish or cancel the current copy first.');
          const folder = window.__externalFolderFixture;
          if (!folder || folder.available === false) throw new Error('Windows bulk tests need a generated external folder; use the iPhone Files picker for an actual SSD.');
          if (params.direction === 'import') await this.call('addFolder');
          else if (!driveState.some(drive => drive.id === folder.id)) { driveState.push({ id: folder.id, name: folder.name, available: true }); localStorage.setItem('hub-test-drives', JSON.stringify(driveState)); }
          const items = snapshot().flatMap(file => {
            if (params.direction === 'import') {
              const existingSource = file.locations.find(source => source.kind === 'phone' && source.available);
              return existingSource && !params.includeImported ? [] : file.locations.filter(source => source.kind === 'drive' && source.driveID === folder.id && source.available).map(source => ({ file, source, existingSource, status: 'pending' }));
            }
            return file.locations.filter(source => source.kind === 'phone' && source.available).map(source => ({ file, source, status: 'pending' }));
          });
          bulk = { id: crypto.randomUUID(), direction: params.direction, driveID: folder.id, status: 'ready', items, removeOriginals: false }; saveBulk(); return bulkStatus();
        }
        case 'replanBulk': {
          if (bulk?.id !== params.id || bulk.status !== 'ready' || bulk.direction !== 'import') throw new Error('Choose an import folder first.');
          return this.call('prepareBulk', { direction: 'import', includeImported: params.removeOriginals === true });
        }
        case 'startBulk': {
          if (bulkRunning || params.id !== bulk?.id) throw new Error('Choose a folder first.');
          bulk.removeOriginals = params.removeOriginals === true; void runBulk(); return bulkStatus();
        }
        case 'cancelBulk': bulkCanceled = true; bulk.status = 'canceling'; saveBulk(); return bulkStatus();
        case 'retryBulk': if (!bulkRunning) void runBulk(); return bulkStatus();
        case 'refreshCatalog': {
          if (!credentials || demo) return { online: false };
          try {
            const files = (await (await api('library')).json()).files;
            for (const entry of catalog) for (const source of entry.locations) if (source.kind === 'pc') source.available = files.some(file => file.id === entry.id);
            for (const file of files) {
              const pending = catalog.find(entry => entry.sourceId === file.sourceId && file.sourceId && entry.locations.some(source => source.kind === 'pending'));
              if (pending) { const existing = catalog.find(entry => entry.id === file.id); pending.id = file.id; pending.locations = existing?.locations || []; catalog = catalog.filter(entry => entry === pending || entry.id !== file.id); }
              const previous = pending || catalog.find(entry => entry.id === file.id);
              const source = { id: 'pc:' + file.id, kind: 'pc', label: 'On PC', available: true };
              if (previous) { if (!previous.organized) Object.assign(previous, file); previous.locations = [...previous.locations.filter(location => location.kind !== 'pc'), source]; }
              else catalog.push({ ...file, locations: [source] });
            }
            rememberCatalog();
            for (const request of [...requests]) {
              const file = files.find(file => file.sourceId === request.sourceId);
              if (!file) continue;
              if (request.copyWhenReady) { await this.call('addQueue', { fileIds: [file.id], destination: request.destination }); for (const row of rows.values()) if (row.status === 'waiting') { row.status = 'queued'; await save(row); } pump(); }
              requests = requests.filter(item => item !== request); rememberRequests();
            }
            return { online: true };
          } catch (error) { return { online: false, error: error.message }; }
        }
        case 'drives': return structuredClone(driveState);
        case 'addFolder': {
          const fixture = window.__externalFolderFixture;
          if (!fixture) throw new Error('Windows preview needs a generated external-folder fixture; use your iPhone for the real Files picker.');
          const drive = { id: fixture.id, name: fixture.name, available: true };
          if (!driveState.some(item => item.id === drive.id)) driveState.push(drive);
          for (const file of fixture.files) if (!catalog.some(item => item.id === file.id)) catalog.push({ ...file, locations: [{ id: 'drive:' + file.id, kind: 'drive', label: 'On SSD · ' + drive.name, available: true, driveID: drive.id }] });
          rememberCatalog(); localStorage.setItem('hub-test-drives', JSON.stringify(driveState));
          return { count: fixture.files.length };
        }
        case 'scanDrive': {
          const drive = driveState.find(drive => drive.id === params.id); if (!drive) throw new Error('Unknown folder.');
          drive.available = window.__externalFolderFixture?.available !== false;
          for (const file of catalog) for (const source of file.locations) if (source.driveID === drive.id) source.available = drive.available;
          rememberCatalog(); localStorage.setItem('hub-test-drives', JSON.stringify(driveState));
          return { count: catalog.filter(file => file.locations.some(source => source.driveID === drive.id)).length };
        }
        case 'organize': {
          const file = catalog.find(file => file.id === params.id);
          if (!file || !params.series || !params.season) throw new Error('Enter a series and season.');
          Object.assign(file, { series: params.series, title: params.series, season: params.season, episode: params.episode, organized: true }); rememberCatalog(); return { saved: true };
        }
        case 'play': {
          const file = snapshot().find(file => file.id === params.id);
          if (!file?.locations.some(source => source.kind !== 'pc' && source.available)) throw new Error('Download this episode or reconnect its drive to play.');
          if (!/\.(mp4|m4v|mov)$/i.test(file.filename)) throw new Error("Apple's player cannot play this video format. You can still export the file.");
          throw new Error('Native playback requires the iPhone. Windows tests validate the request and file availability.');
        }
        case 'importFiles': throw new Error('Use the iPhone Files picker to import actual files.');
        case 'importEpisode': throw new Error('Use the iPhone to copy actual SSD files.');
        case 'exportEpisode': {
          const file = snapshot().find(file => file.id === params.id);
          const source = file?.locations.find(source => source.kind === 'phone');
          if (!source) throw new Error('Use the iPhone to export SSD files.');
          return this.call('export', { id: source.transferId });
        }
        case 'deleteEpisode': {
          const file = catalog.find(file => file.id === params.id); if (!file) throw new Error('Episode not found.');
          for (const source of file.locations.filter(source => source.kind === 'phone')) await this.call('delete', { id: source.transferId });
          file.locations = file.locations.filter(source => source.kind !== 'phone'); rememberCatalog(); return { deleted: true };
        }
        case 'queue': return demo ? demoQueue : transfers();
        case 'fetcherStatus':
        case 'fetcherSearch':
        case 'fetcherTitle':
        case 'fetcherAdd':
        case 'fetcherControl': {
          if (demo) throw new Error('Demo — PC runner controls unavailable');
          if (method === 'fetcherStatus') return (await api('download-jobs')).json();
          if (method === 'fetcherSearch') return (await api('fetcher/search?' + new URLSearchParams({ q: params.query, page: params.page || 1 }))).json();
          if (method === 'fetcherTitle') { const title = await (await api('fetcher/titles/' + encodeURIComponent(params.id))).json(); titles.set(title.id, title); return title; }
          if (method === 'fetcherAdd') {
            const result = await (await api('download-jobs', 'POST', { titleId: params.titleId, episodeIds: params.episodeIds, series: params.series })).json();
            const title = titles.get(params.titleId);
            for (const episode of title?.episodes || []) if (params.episodeIds.includes(episode.id)) {
              const sourceId = title.id + '/' + episode.id;
              if (!requests.some(request => request.sourceId === sourceId)) requests.push({ sourceId, destination: params.destination || 'phone', copyWhenReady: params.copyWhenReady !== false });
              if (!catalog.some(file => file.sourceId === sourceId)) catalog.push({ id: 'pending:' + sourceId, sourceId, series: params.series, title: title.title, season: 'Pending downloads', episode: Number(episode.number), filename: 'Episode ' + episode.number, bytes: 0, locations: [{ id: 'pending:' + sourceId, kind: 'pending', label: 'Downloading on PC', available: false }] });
            }
            rememberCatalog(); rememberRequests(); return result;
          }
          return (await api('download-jobs/control', 'POST', params)).json();
        }
        case 'addQueue': {
          if (demo) {
            for (const id of params.fileIds) { const file = demoFiles.find(file => file.id === id); if (!file) throw new Error('Unknown demo file.'); if (!demoQueue.some(row => row.fileId === id)) demoQueue.push({ ...file, fileId: id, status: 'queued', bytesCompleted: 0 }); }
            return demoQueue;
          }
          if (params.destination && params.destination !== 'phone') throw new Error('Direct SSD writes require the native iPhone engine.');
          for (const id of params.fileIds) {
            const file = catalog.find(file => file.id === id);
            if (!file?.locations.some(source => source.kind === 'pc')) throw new Error('This episode has no PC copy.');
            if (file.locations.some(source => source.kind === 'phone' && source.available)) continue;
            if ([...rows.values()].some(row => row.fileId === id && !['downloaded', 'failed'].includes(row.status))) continue;
            const entry = { ...file, id: crypto.randomUUID().replaceAll('-', '').slice(0, 24), fileId: id, clientOwned: true };
            const row = { id: entry.id, fileId: id, filename: file.filename, bytes: file.bytes, status: 'waiting', received: 0, chunks: [], error: '', verifiedSHA256: '', entry };
            rows.set(row.id, row); await save(row);
          }
          return transfers();
        }
        case 'transfers': return transfers();
        case 'start': {
          if (demo) throw new Error('Demo — file transfers unavailable');
          const queue = await (await api('queue')).json();
          for (const entry of queue) {
            if (entry.status === 'downloaded') continue;
            const existing = rows.get(entry.id);
            if (existing && ['paused', 'failed'].includes(existing.status)) existing.status = 'queued';
            else if (!existing) rows.set(entry.id, { id: entry.id, fileId: entry.fileId, filename: entry.filename, bytes: entry.bytes, status: 'queued', received: 0, chunks: [], error: '', verifiedSHA256: '', entry });
          }
          for (const row of rows.values()) if (row.status === 'waiting') { row.status = 'queued'; await save(row); }
          pump(); return transfers();
        }
        case 'pause': await pause(params.id); return transfers();
        case 'resume': {
          if (!credentials) throw new Error('Connect the PC before resuming.');
          const row = getRow(params.id);
          if (!['paused', 'failed'].includes(row.status)) throw new Error('Transfer cannot resume in this state.');
          if (jobs.has(row.id)) await jobs.get(row.id).done;
          row.status = 'queued'; await save(row); pump(); return transfers();
        }
        case 'export': {
          const row = getRow(params.id);
          if (row.status !== 'downloaded' || !row.verifiedSHA256) throw new Error('Saved file is unavailable.');
          const url = URL.createObjectURL(new Blob(row.chunks)), link = document.createElement('a');
          link.href = url; link.download = row.filename; document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return { exported: true };
        }
        case 'delete': {
          const row = getRow(params.id);
          if (row.status !== 'downloaded') throw new Error('Only a finished file can be deleted here.');
          await writes; await transaction('readwrite', store => store.delete(row.id)); rows.delete(row.id);
          for (const file of catalog) file.locations = file.locations.filter(source => source.transferId !== row.id);
          rememberCatalog(); notify(); return transfers();
        }
        case 'disconnect': {
          for (const row of rows.values()) if (row.status === 'queued') { row.status = 'paused'; await save(row); }
          await Promise.all([...jobs.keys()].map(pause));
          credentials = null; demo = false; sessionStorage.removeItem('hub-test-connection'); return connection();
        }
        case 'demo': demo = true; demoQueue = []; return connection();
        default: throw new Error('Unsupported app command.');
      }
    }
  };
})();
