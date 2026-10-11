import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHub } from '../server.mjs';

// Always isolated from the user's collection, devices and transfer queue.
export async function startFixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'download-hub-simulator-'));
  let hub;
  try {
    const libraryRoot = path.join(root, 'library');
    await mkdir(path.join(libraryRoot, 'Demo'), { recursive: true });
    const items = [];
    for (let episode = 1; episode <= 2; episode++) {
      const file = `Demo Episode ${episode}.bin`;
      const requestedBytes = Number(options.bytes || process.env.HUB_FIXTURE_BYTES || 2 * 1024 * 1024);
      if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1 || requestedBytes > 16 * 1024 * 1024) throw new Error('Invalid generated fixture size');
      const payload = Buffer.alloc(requestedBytes);
      for (let offset = 0; offset < payload.length; offset++) payload[offset] = (offset + episode) % 251;
      await writeFile(path.join(libraryRoot, 'Demo', file), payload);
      items.push({ id: `demo-${episode}`, series: 'Demo Series', title: 'Test Season', code: 'S01', episode, folder: 'Demo', file, bytes: payload.length, status: 'complete' });
    }
    await writeFile(path.join(libraryRoot, 'download-queue.json'), JSON.stringify({ status: 'complete', items }));
    const fetcherClient = options.fetcherClient ?? (async () => { throw Object.assign(new Error('Fetcher is disabled in this isolated test preview.'), { status: 503 }); });
    hub = await createHub({ libraryRoot, stateRoot: path.join(root, 'state'), testing: true, fetcherClient });
    const address = await hub.listen(0);
    const server = `http://127.0.0.1:${address.port}`;
    const session = await fetch(server + '/api/local-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!session.ok) throw new Error('Fixture admin session failed');
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const pairing = await fetch(server + '/api/pairing', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    if (!pairing.ok) throw new Error('Fixture pairing failed');
    const { code } = await pairing.json();
    return { server, code, cookie, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    if (hub) await hub.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const connectionFile = process.argv[2];
  if (!connectionFile) throw new Error('Usage: node fixture-server.mjs <temporary-connection.json>');
  const fixture = await startFixture();
  await writeFile(connectionFile, JSON.stringify({ server: fixture.server, code: fixture.code, cookie: fixture.cookie }), { mode: 0o600 });
  console.log('Synthetic transfer fixture ready (2 generated files).');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await fixture.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
