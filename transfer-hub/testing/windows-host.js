// Served ONLY by the generated-file fixture, never by the real collection service.
// This implements the native bridge contract for free Windows UI/transfer tests.
// Browser storage is a test substitute for iOS app storage and background tasks.
(() => {
  let credentials = JSON.parse(sessionStorage.getItem('hub-test-connection') || 'null');
  let demo = false, demoQueue = [];
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
    return [...rows.values()].map(({ chunks, expectedSHA256, etag, entry, ...row }) => ({ ...row, canExport: row.status === 'downloaded' && row.received === row.bytes && Boolean(row.verifiedSHA256) }));
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
        case 'library': return demo ? demoFiles : (await (await api('library')).json()).files;
        case 'queue': return demo ? demoQueue : (await api('queue')).json();
        case 'fetcherStatus':
        case 'fetcherSearch':
        case 'fetcherTitle':
        case 'fetcherAdd':
        case 'fetcherControl': {
          if (demo) throw new Error('Demo — PC runner controls unavailable');
          if (method === 'fetcherStatus') return (await api('download-jobs')).json();
          if (method === 'fetcherSearch') return (await api('fetcher/search?' + new URLSearchParams({ q: params.query, page: params.page || 1 }))).json();
          if (method === 'fetcherTitle') return (await api('fetcher/titles/' + encodeURIComponent(params.id))).json();
          if (method === 'fetcherAdd') return (await api('download-jobs', 'POST', params)).json();
          return (await api('download-jobs/control', 'POST', params)).json();
        }
        case 'addQueue': {
          if (demo) {
            for (const id of params.fileIds) { const file = demoFiles.find(file => file.id === id); if (!file) throw new Error('Unknown demo file.'); if (!demoQueue.some(row => row.fileId === id)) demoQueue.push({ ...file, fileId: id, status: 'queued', bytesCompleted: 0 }); }
            return demoQueue;
          }
          return (await api('queue', 'POST', { fileIds: params.fileIds })).json();
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
          await writes; await transaction('readwrite', store => store.delete(row.id)); rows.delete(row.id); notify(); return transfers();
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
