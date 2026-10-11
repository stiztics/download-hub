import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { stateRoot as defaultState } from './paths.mjs';
export function createFetcherClient(stateRoot = defaultState) {
  return async (route, { method = 'GET', body } = {}) => {
    let connection;
    try { connection = JSON.parse(await readFile(path.join(stateRoot, 'connection.json'), 'utf8')); }
    catch { throw Object.assign(new Error('Fetcher is offline. Run Start Fetcher.cmd on the PC.'), { status: 503 }); }
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('Invalid fetcher connection file.');
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${connection.port}${route}`, {
        method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240000),
      });
    } catch { throw Object.assign(new Error('Fetcher is unavailable or the request timed out. Check runner.log on the PC.'), { status: 503 }); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status, code: data.code });
    return data;
  };
}
