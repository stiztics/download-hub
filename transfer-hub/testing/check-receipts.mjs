import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const connection = JSON.parse(await readFile(process.argv[2], 'utf8'));
const stateFile = process.argv[3];
assert.ok(stateFile, 'Pass the simulator native transfer history path');
const rows = JSON.parse(await readFile(stateFile, 'utf8'));
assert.equal(rows.length, 2);
for (const row of rows) {
  assert.equal(row.status, 'downloaded');
  assert.equal(row.received, row.entry.bytes);
  const bytes = await readFile(path.resolve(path.dirname(stateFile), '../../../Documents', row.localName));
  assert.equal(bytes.length, row.entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.verifiedSHA256);
}
const response = await fetch(connection.server + '/api/queue', { headers: { Cookie: connection.cookie } });
assert.equal(response.status, 200);
assert.equal((await response.json()).length, 0, 'Phone-owned transfers do not require a desktop pickup queue');
console.log('Both native files and checksums verified; desktop pickup queue remains empty.');
