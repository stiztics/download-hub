import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createHub, byteRange } from '../server.mjs';

test('range parser handles resume, suffix and unsatisfiable requests', () => {
  assert.deepEqual(byteRange('bytes=20-', 100), { start: 20, end: 99 });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=0-200', 100), { start: 0, end: 99 });
  for (const value of ['bytes=100-', 'bytes=-0', 'bytes=20-10', 'bytes=0-1,5-8', 'bytes=9007199254740993-']) assert.equal(byteRange(value, 100), false);
});

test('Dragon Ball movie folders are exposed as movies without changing filenames or IDs', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'dragon-ball-library-'));
  const libraryRoot=path.join(root,'Anime');
  const folder='Dragon Ball/Movies/2018 - Super Broly';
  const file='Dragon Ball - Super Broly - E001 [1080p SUB].mp4';
  await mkdir(path.join(libraryRoot,folder),{recursive:true});
  await writeFile(path.join(libraryRoot,folder,file),'test');
  await writeFile(path.join(libraryRoot,'download-queue.json'),JSON.stringify({items:[{id:'broly/one',series:'Dragon Ball',title:'Dragon Ball Super: Broly',folder,file,code:'Super Broly - ',episode:1,status:'complete',bytes:4}]}));
  const hub=await createHub({libraryRoot,stateRoot:path.join(root,'state')});
  const {port}=await hub.listen(0);
  t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const session=await fetch(base+'/api/local-session',{method:'POST'});
  const headers={Cookie:session.headers.get('set-cookie').split(';')[0]};
  const library=await (await fetch(base+'/api/library',{headers})).json();
  assert.equal(library.files[0].season,'Movie');
  assert.equal(library.files[0].filename,file);
  assert.equal(library.files[0].id,createHash('sha256').update('broly/one\0'+path.join(folder,file)).digest('hex'));
  const download=await fetch(base+'/api/files/'+library.files[0].id,{method:'HEAD',headers});
  assert.equal(download.status,200);
  assert.equal(download.headers.get('content-length'),'4');
});

test('authenticated library, pairing, durable queue and byte-perfect resumed transfer', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'download-hub-test-'));
  const libraryRoot = path.join(root, 'library');
  const stateRoot = path.join(root, 'state');
  await mkdir(path.join(libraryRoot, 'Series'), { recursive: true });
  const payload = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 251));
  await writeFile(path.join(libraryRoot, 'Series', 'Episode 01.mp4'), payload);
  await writeFile(path.join(root, 'outside.mp4'), payload);
  await writeFile(path.join(libraryRoot, 'Series', 'wrong.mp4'), Buffer.from('wrong'));
  await writeFile(path.join(libraryRoot, 'download-queue.json'), JSON.stringify({ status: 'complete', items: [
    { id: 'one', series: 'Example', title: 'Example Season 1', code: 'S01', episode: 1, folder: 'Series', file: 'Episode 01.mp4', bytes: payload.length, status: 'complete' },
    { id: 'pending', folder: 'Series', file: 'unfinished.part', bytes: 100, status: 'downloading' },
    { id: 'escape', folder: '..', file: 'outside.mp4', bytes: payload.length, status: 'complete' },
    { id: 'mismatch', folder: 'Series', file: 'wrong.mp4', bytes: payload.length, status: 'complete' },
    { id: 'missing', folder: 'Series', file: 'missing.mp4', bytes: 100, status: 'complete' }
  ] }));
  let hub = await createHub({ libraryRoot, stateRoot });
  let address = await hub.listen(0);
  let base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (route, options = {}) => fetch(base + route, options);
  assert.equal((await call('/app/')).status, 200);
  assert.equal((await call('/app/windows-host.js')).status, 404, 'Windows test adapter must not be served by the real library service');
  assert.equal((await call('/app/../testing/windows-host.js')).status, 404);
  const post = (route, value, headers = {}) => call(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await call('/api/library')).status, 401);
  assert.equal((await post('/api/local-session', {}, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
  assert.equal((await post('/api/local-session', {}, { 'X-Forwarded-Proto': 'https' })).status, 403);
  const hostCheck = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/local-session', { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(hostCheck, 403);
  assert.equal((await post('/api/local-session', {}, { Origin: 'https://evil.example' })).status, 403);
  const session = await post('/api/local-session', {});
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const admin = { Cookie: cookie };
  const library = await (await call('/api/library', { headers: admin })).json();
  assert.equal(library.files.length, 1);
  assert.equal(library.unavailable, 3);
  assert.equal(library.files[0].physical, undefined);
  const fileId = library.files[0].id;
  assert.equal((await post('/api/queue', { fileIds: ['unknown'] }, admin)).status, 400);
  await post('/api/queue', { fileIds: [fileId, fileId] }, admin);
  const queue = await (await post('/api/queue', { fileIds: [fileId] }, admin)).json();
  assert.equal(queue.length, 1);
  const pairing = await (await post('/api/pairing', {}, admin)).json();
  assert.equal((await post('/api/pair', { code: '00000000' })).status, 401);
  const paired = await (await post('/api/pair', { code: pairing.code, name: 'Test iPhone', client: 'ios' })).json();
  assert.equal((await post('/api/pair', { code: pairing.code })).status, 401);
  const phone = { Authorization: `Bearer ${paired.token}` };
  assert.equal((await post('/api/pairing', {}, phone)).status, 403);
  const download = `/api/files/${fileId}`;
  assert.equal((await call(download)).status, 401);
  const head = await call(download, { method: 'HEAD', headers: phone });
  assert.equal(Number(head.headers.get('content-length')), payload.length);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.match(head.headers.get('content-disposition'), /attachment/);
  const first = await call(download, { headers: { ...phone, Range: 'bytes=0-1023' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-1023/${payload.length}`);
  const rest = await call(download, { headers: { ...phone, Range: 'bytes=1024-', 'If-Range': head.headers.get('etag') } });
  assert.deepEqual(Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await rest.arrayBuffer())]), payload);
  assert.equal((await call(download, { headers: { ...phone, Range: 'bytes=0-9', 'If-Range': '"stale"' } })).status, 200);
  const invalid = await call(download, { headers: { ...phone, Range: 'bytes=99999-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${payload.length}`);
  const checksum = await (await call(download + '/checksum', { headers: phone })).json();
  assert.equal(checksum.sha256, createHash('sha256').update(payload).digest('hex'));
  const progress = (value, headers) => call(`/api/queue/${queue[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await progress({ status: 'downloaded', bytesCompleted: payload.length }, admin)).status, 403);
  assert.equal((await progress({ status: 'downloaded', bytesCompleted: 0 }, phone)).status, 400);
  assert.equal((await progress({ status: 'downloading', bytesCompleted: 1024 }, phone)).status, 200);
  assert.equal((await call(`/api/queue/${queue[0].id}`, { method: 'DELETE', headers: admin })).status, 409);
  assert.equal((await progress({ status: 'downloaded', bytesCompleted: payload.length, reportedAt: 300 }, phone)).status, 200);
  const stale = await (await progress({ status: 'downloading', bytesCompleted: 100, reportedAt: 200 }, phone)).json();
  assert.equal(stale.status, 'downloaded');
  assert.equal(stale.bytesCompleted, payload.length);
  await hub.close();
  hub = await createHub({ libraryRoot, stateRoot }); address = await hub.listen(0); base = `http://127.0.0.1:${address.port}`;
  assert.equal((await call('/api/library', { headers: phone })).status, 200);
  const restored = await (await call('/api/queue', { headers: phone })).json();
  assert.equal(restored[0].status, 'downloaded');
  const newSession = await post('/api/local-session', {});
  const newAdmin = { Cookie: newSession.headers.get('set-cookie').split(';')[0] };
  assert.equal((await call('/api/devices', { method: 'DELETE', headers: newAdmin })).status, 200);
  assert.equal((await call(download, { headers: phone })).status, 401);
  assert.equal((await call('/.state/hub.json')).status, 404);
  assert.equal((await call('/phone')).status, 200);
});
