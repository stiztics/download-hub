import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createFetcherClient } from '../fetcher/client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end;
  if (!match[1]) { const length = Number(match[2]); if (!Number.isSafeInteger(length) || length <= 0) return false; start = Math.max(0, size - length); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

export async function createHub(options = {}) {
  const libraryRoot = path.resolve(options.libraryRoot ?? path.join(here, '../Anime'));
  const manifestPath = options.manifestPath ?? path.join(libraryRoot, 'download-queue.json');
  const fetcher = options.fetcherClient ?? createFetcherClient();
  const stateRoot = path.resolve(options.stateRoot ?? path.join(here, '.state'));
  await mkdir(stateRoot, { recursive: true });
  const statePath = path.join(stateRoot, 'hub.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, devices: [], queue: [] }; }
  if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.queue)) throw new Error('Invalid transfer hub state.');
  let writes = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(state, null, 2);
    const next = writes.then(async () => { await writeFile(statePath + '.tmp', snapshot); await rename(statePath + '.tmp', statePath); });
    writes = next.catch(() => {});
    return next;
  }
  const adminToken = randomBytes(32).toString('hex');
  let pairing = null;
  const attempts = new Map();
  const checksums = new Map();
  const active = new Set();

  async function library() {
    const manifests = [];
    for (const source of [manifestPath, path.join(libraryRoot, 'fetcher-library.json')]) {
      try { manifests.push(JSON.parse(await readFile(source, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!manifests.length) return { files: [], unavailable: 0, sourceStatus: 'No download collection found' };
    const manifest = { status: manifests.map(x => x.status || 'unknown').join(' / '), items: manifests.flatMap(x => x.items ?? []) };
    const base = await realpath(libraryRoot);
    let unavailable = 0;
    const files = [];
    const seen = new Set();
    for (const item of manifest.items ?? []) {
      if (item.status !== 'complete') continue;
      if (typeof item.file !== 'string' || path.basename(item.file) !== item.file || typeof item.folder !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) { unavailable++; continue; }
      const resolved = path.resolve(libraryRoot, item.folder, item.file);
      if (!resolved.startsWith(libraryRoot + path.sep)) { unavailable++; continue; }
      try {
        const physical = await realpath(resolved);
        if (!physical.startsWith(base + path.sep)) { unavailable++; continue; }
        const info = await stat(physical);
        if (!info.isFile() || info.size !== item.bytes || /\.(part|copying)$/i.test(item.file)) { unavailable++; continue; }
        if (seen.has(physical)) continue;
        seen.add(physical);
        const season = item.folder.split(/[\\/]/).some(part => part.toLowerCase() === 'movies') ? 'Movie' : item.code || 'Season';
        files.push({ id: sha(String(item.id) + '\0' + path.relative(libraryRoot, resolved)), series: item.series || 'Other', title: item.title || item.series || 'Untitled', season, episode: item.episode, filename: item.file, bytes: info.size, quality: item.quality || null, completedAt: item.completedAt || null, sourceId: item.sourceId || (String(item.id).includes('/') ? String(item.id) : null), physical, mtime: info.mtimeMs });
      } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; unavailable++; }
    }
    return { files, unavailable, sourceStatus: manifest.status ?? 'unknown' };
  }
  const publicFile = ({ physical, mtime, ...file }) => ({ ...file, fingerprint: sha(`${file.id}:${file.bytes}:${mtime}`) });
  function json(res, status, value, extra = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(value)); }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON body required.'), { status: 415 });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }
  function auth(req) {
    const cookies = (req.headers.cookie ?? '').split(';').map(x => x.trim());
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : cookies.find(x => x.startsWith('hub_session='))?.slice(12);
    if (!token) return null;
    if (equal(token, adminToken)) return { role: 'admin' };
    const device = state.devices.find(x => equal(x.tokenHash, sha(token)));
    return device ? { role: 'device', device } : null;
  }
  function localAdminRequest(req) {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    return loopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-proto'] && !req.headers.forwarded;
  }
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true; // Native clients don't send Origin.
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return json(res, 403, { error: 'Cross-site request refused.' });
      if (route === '/api/status' && req.method === 'GET') return json(res, 200, { name: 'Download Hub', online: true, version: 1 });
      if (route === '/api/local-session' && req.method === 'POST') {
        if (!localAdminRequest(req)) return json(res, 403, { error: 'Open the dashboard on this PC to manage pairing.' });
        return json(res, 200, { role: 'admin' }, { 'Set-Cookie': `hub_session=${adminToken}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (route === '/api/pair' && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        const now = Date.now();
        for (const [address, value] of attempts) if (now - value.at > 900000) attempts.delete(address);
        let attempt = attempts.get(key) ?? { count: 0, at: now };
        if (now - attempt.at > 900000) attempt = { count: 0, at: now };
        attempt.count++; attempts.set(key, attempt);
        if (attempt.count > 30) return json(res, 429, { error: 'Too many pairing attempts. Try again in 15 minutes.' });
        const input = await body(req);
        if (!pairing || now > pairing.expiresAt || !equal(String(input.code), pairing.code)) return json(res, 401, { error: 'Pairing code is invalid or expired. Generate another on the PC.' });
        const token = randomBytes(32).toString('hex');
        const device = { id: randomBytes(12).toString('hex'), name: String(input.name || 'iPhone').slice(0, 60), tokenHash: sha(token), pairedAt: new Date().toISOString() };
        // A single personal phone is supported. Replacement revokes its prior token.
        state.devices = [device]; pairing = null;
        await save();
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
        return json(res, 200, { device: { id: device.id, name: device.name }, ...(input.client === 'ios' ? { token } : {}) }, { 'Set-Cookie': `hub_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}` });
      }
      if (route.startsWith('/api/')) {
        const identity = auth(req);
        if (!identity) return json(res, 401, { error: 'Pair this device to access your downloads.' });
        if (route === '/api/session' && req.method === 'GET') return json(res, 200, { role: identity.role, device: identity.device ? { id: identity.device.id, name: identity.device.name } : null });
        if (route === '/api/fetcher/search' && req.method === 'GET') return json(res, 200, await fetcher('/search' + url.search));
        const fetcherTitle = /^\/api\/fetcher\/titles\/([\w-]+)$/.exec(route);
        if (fetcherTitle && req.method === 'GET') return json(res, 200, await fetcher('/titles/' + fetcherTitle[1]));
        if (route === '/api/download-jobs' && req.method === 'GET') return json(res, 200, await fetcher('/status'));
        if (route === '/api/download-jobs' && req.method === 'POST') return json(res, 201, await fetcher('/jobs', { method: 'POST', body: await body(req) }));
        if (route === '/api/download-jobs/control' && req.method === 'POST') return json(res, 200, await fetcher('/control', { method: 'POST', body: await body(req) }));
        if (route === '/api/pairing' && req.method === 'POST') {
          if (identity.role !== 'admin') return json(res, 403, { error: 'Only the PC can generate a pairing code.' });
          pairing = { code: String(randomInt(10000000, 100000000)), expiresAt: Date.now() + 600000 };
          return json(res, 200, pairing);
        }
        if (route === '/api/devices' && req.method === 'GET') {
          if (identity.role !== 'admin') return json(res, 403, { error: 'Only the PC can manage devices.' });
          return json(res, 200, state.devices.map(({ tokenHash, ...device }) => device));
        }
        if (route === '/api/devices' && req.method === 'DELETE') {
          if (identity.role !== 'admin') return json(res, 403, { error: 'Only the PC can manage devices.' });
          state.devices = []; pairing = null; await save(); return json(res, 200, { revoked: true });
        }
        if (route === '/api/library' && req.method === 'GET') {
          const result = await library();
          return json(res, 200, { ...result, files: result.files.map(publicFile) });
        }
        if (route === '/api/queue' && req.method === 'GET') return json(res, 200, state.queue);
        if (route === '/api/queue' && req.method === 'POST') {
          const input = await body(req);
          if (!Array.isArray(input.fileIds) || !input.fileIds.length || input.fileIds.length > 500 || input.fileIds.some(x => typeof x !== 'string')) return json(res, 400, { error: 'Choose between 1 and 500 files.' });
          const { files } = await library();
          const known = new Map(files.map(x => [x.id, x]));
          if (input.fileIds.some(x => !known.has(x))) return json(res, 400, { error: 'Some selected files are no longer available.' });
          for (const fileId of new Set(input.fileIds)) {
            if (state.queue.some(x => x.fileId === fileId && ['queued', 'downloading'].includes(x.status))) continue;
            const file = known.get(fileId);
            state.queue.push({ id: randomBytes(12).toString('hex'), fileId, filename: file.filename, series: file.series, title: file.title, bytes: file.bytes, status: 'queued', bytesCompleted: 0, error: null, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          }
          await save(); return json(res, 200, state.queue);
        }
        const queueMatch = /^\/api\/queue\/([a-f0-9]{24})$/.exec(route);
        if (queueMatch && req.method === 'DELETE') {
          const entry = state.queue.find(x => x.id === queueMatch[1]);
          if (!entry) return json(res, 404, { error: 'Queue item not found.' });
          if (entry.status === 'downloading') return json(res, 409, { error: 'Pause or cancel the download on your iPhone first.' });
          state.queue = state.queue.filter(x => x.id !== entry.id); await save(); return json(res, 200, { removed: true });
        }
        if (queueMatch && req.method === 'PATCH') {
          if (identity.role !== 'device') return json(res, 403, { error: 'Only the paired device reports download progress.' });
          const input = await body(req);
          const entry = state.queue.find(x => x.id === queueMatch[1]);
          if (!entry) return json(res, 404, { error: 'Queue item not found.' });
          if (!['queued', 'downloading', 'downloaded', 'failed', 'paused'].includes(input.status) || !Number.isSafeInteger(input.bytesCompleted) || input.bytesCompleted < 0 || input.bytesCompleted > entry.bytes || (input.status === 'downloaded' && input.bytesCompleted !== entry.bytes)) return json(res, 400, { error: 'Invalid progress report.' });
          if (input.reportedAt !== undefined && !Number.isSafeInteger(input.reportedAt)) return json(res, 400, { error: 'Invalid progress timestamp.' });
          // Background progress requests can arrive out of order. A completed
          // receipt must never regress to an earlier in-flight status.
          if ((input.reportedAt !== undefined && input.reportedAt <= (entry.reportedAt ?? 0)) || (entry.status === 'downloaded' && input.status !== 'downloaded')) return json(res, 200, entry);
          Object.assign(entry, { status: input.status, bytesCompleted: input.bytesCompleted, error: input.status === 'failed' ? String(input.error || 'Download failed').slice(0, 300) : null, updatedAt: new Date().toISOString() });
          if (input.reportedAt !== undefined) entry.reportedAt = input.reportedAt;
          await save(); return json(res, 200, entry);
        }
        const fileMatch = /^\/api\/files\/([a-f0-9]{64})(\/checksum)?$/.exec(route);
        if (fileMatch && ['GET', 'HEAD'].includes(req.method)) {
          const { files } = await library();
          const file = files.find(x => x.id === fileMatch[1]);
          if (!file) return json(res, 404, { error: 'Completed file not found.' });
          if (fileMatch[2]) {
            const cacheKey = `${file.id}:${file.bytes}:${file.mtime}`;
            let digest = checksums.get(cacheKey);
            if (!digest) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file.physical)) hash.update(chunk); digest = hash.digest('hex'); if (checksums.size > 1000) checksums.clear(); checksums.set(cacheKey, digest); }
            return json(res, 200, { sha256: digest, bytes: file.bytes });
          }
          const etag = `"${sha(`${file.id}:${file.bytes}:${file.mtime}`)}"`;
          const header = req.headers['if-range'] && req.headers['if-range'] !== etag ? null : req.headers.range;
          const range = byteRange(header, file.bytes);
          if (range === false) return json(res, 416, { error: 'Invalid byte range.' }, { 'Content-Range': `bytes */${file.bytes}` });
          if (!range && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
          const ascii = file.filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
          const headers = { 'Content-Type': file.filename.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, x => '%' + x.charCodeAt(0).toString(16))}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', ETag: etag, 'Content-Length': range ? range.end - range.start + 1 : file.bytes };
          if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.bytes}`;
          res.writeHead(range ? 206 : 200, headers);
          if (req.method === 'HEAD') return res.end();
          active.add(res);
          try { await pipeline(createReadStream(file.physical, range ?? {}), res); } finally { active.delete(res); }
          return;
        }
        return json(res, 404, { error: 'Endpoint not found.' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      if (route === '/app') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
      const phoneAssets = { '/app/': 'index.html', '/app/index.html': 'index.html', '/app/app.js': 'app.js', '/app/bridge.js': 'bridge.js', '/app/style.css': 'style.css' };
      if (phoneAssets[route] || (options.testing === true && route === '/app/windows-host.js')) {
        const asset = phoneAssets[route] || 'windows-host.js';
        const content = await readFile(path.join(here, phoneAssets[route] ? 'phone' : 'testing', asset));
        res.writeHead(200, { 'Content-Type': `${mime[path.extname(asset)]}; charset=utf-8`, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      const assets = { '/': 'index.html', '/phone': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' };
      if (!assets[route]) return json(res, 404, { error: 'Page not found.' });
      const content = await readFile(path.join(here, 'web', assets[route]));
      res.writeHead(200, { 'Content-Type': `${mime[path.extname(assets[route])]}${path.extname(assets[route]) === '.svg' ? '' : '; charset=utf-8'}`, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error.status || 500, { error: error.status ? error.message : 'The hub could not complete this request. Check the local service console.' });
      if (!error.status && !['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code)) console.error('Hub request failed:', error.message);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  return { server, listen: (port = options.port ?? 4318, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }), close: async () => { for (const response of active) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await writes; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = await createHub();
  const address = await hub.listen();
  console.log(`Download Hub: http://127.0.0.1:${address.port}`);
  console.log(`Phone browser preview: http://127.0.0.1:${address.port}/phone`);
  console.log('Local access only. For your iPhone later, use Tailscale Serve with HTTPS.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await hub.close(); process.exit(0); });
}
