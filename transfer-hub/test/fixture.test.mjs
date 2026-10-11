import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFixture } from '../testing/fixture-server.mjs';

test('cloud simulator fixture pairs and serves two generated, verifiable files', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  assert.equal((await fetch(fixture.server + '/app/windows-host.js')).status, 200);
  const invalid = await fetch(fixture.server + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '00000000', client: 'ios' }) });
  assert.equal(invalid.status, 401);
  const paired = await fetch(fixture.server + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: fixture.code, name: 'Synthetic iPhone', client: 'ios' }) });
  assert.equal(paired.status, 200);
  const headers = { Authorization: `Bearer ${(await paired.json()).token}` };
  const library = await (await fetch(fixture.server + '/api/library', { headers })).json();
  assert.equal(library.files.length, 2);
  assert.equal(library.unavailable, 0);
  for (const file of library.files) {
    assert.equal(file.series, 'Demo Series');
    const checksum = await (await fetch(fixture.server + `/api/files/${file.id}/checksum`, { headers })).json();
    const response = await fetch(fixture.server + `/api/files/${file.id}`, { headers });
    assert.equal(response.status, 200);
    const payload = Buffer.from(await response.arrayBuffer());
    assert.equal(payload.length, 2 * 1024 * 1024);
    assert.equal(checksum.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(checksum.bytes, payload.length);
  }
});
