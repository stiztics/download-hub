import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const connection = JSON.parse(await readFile(process.argv[2], 'utf8'));
// Wait for asynchronous phone receipts; do not accept screenshots alone as proof.
for (let attempt = 0; attempt < 30; attempt++) {
  const response = await fetch(connection.server + '/api/queue', { headers: { Cookie: connection.cookie } });
  assert.equal(response.status, 200);
  const queue = await response.json();
  if (queue.length === 2 && queue.every(entry => entry.status === 'downloaded' && entry.bytesCompleted === entry.bytes)) {
    console.log('Both synthetic files reported fully downloaded.'); process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error('Simulator did not report both complete downloads');
