import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../testing/fixture-server.mjs';

const test = base.extend({
  hub: async ({}, use) => { const fixture = await startFixture(); try { await use(fixture); } finally { await fixture.close(); } },
  runtimeErrors: [async ({ page }, use) => { const errors = []; page.on('pageerror', error => errors.push(error.message)); await use(errors); expect(errors).toEqual([]); }, { auto: true }]
});
async function pair(page, hub, invalid = false) {
  await page.goto(hub.server + '/app/');
  await expect(page.locator('#platform-note')).toContainText('Windows test mode');
  await page.getByLabel('PC address', { exact: true }).fill(hub.server);
  await page.getByLabel('Pairing code', { exact: true }).fill(invalid ? '00000000' : hub.code);
  await page.getByRole('button', { name: 'Connect to PC', exact: true }).click();
  if (invalid) {
    await expect(page.getByRole('status')).toContainText('invalid or expired');
    await page.getByLabel('Pairing code', { exact: true }).fill(hub.code);
    await page.getByRole('button', { name: 'Connect to PC', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
  await expect(page.locator('#toast')).toBeHidden();
}
async function queue(page, all = true) {
  await page.getByRole('button', { name: 'Browse Demo Series', exact: true }).click();
  if (all) await page.getByRole('button', { name: 'Select all', exact: true }).click();
  else await page.locator('#episode-list input').first().check();
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pickup queue', exact: true })).toBeVisible();
}
async function capture(page, testInfo, name) { const path = testInfo.outputPath(name + '.png'); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path }); await testInfo.attach(name, { path, contentType: 'image/png' }); }
async function complete(page, count) {
  await page.getByRole('button', { name: 'Downloaded', exact: true }).click();
  await expect(page.locator('#saved-list .card')).toHaveCount(count, { timeout: 20000 });
  await expect(page.locator('#saved-summary')).toContainText(`${count} files`);
  await expect(page.locator('#saved-list')).toContainText('SHA-256 verified');
}
async function received(page) { return page.evaluate(async () => (await Hub.call('transfers'))[0]?.received || 0); }

test('shared phone UI transfers, pauses, verifies, persists, exports and deletes', async ({ page, hub }, testInfo) => {
  const ranges = [];
  page.on('request', request => { if (request.headers().range) ranges.push(request.headers().range); });
  await pair(page, hub, true);
  const info = await page.evaluate(() => Hub.call('connection'));
  expect(info.token).toBeUndefined();
  await queue(page);
  await page.getByRole('button', { name: 'Download queued files', exact: true }).click();
  await expect.poll(() => received(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
  await expect(page.locator('#queue-list')).toContainText('paused');
  await capture(page, testInfo, 'paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
  await complete(page, 2);
  expect(ranges.some(range => /^bytes=[1-9]\d*-/.test(range))).toBe(true);
  await capture(page, testInfo, 'verified-files');
  await expect.poll(async () => {
    const response = await fetch(hub.server + '/api/queue', { headers: { Cookie: hub.cookie } });
    return (await response.json()).filter(entry => entry.status === 'downloaded' && entry.bytesCompleted === entry.bytes).length;
  }).toBe(2);
  await page.reload();
  await complete(page, 2);
  const exportedPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export file', exact: true }).first().click();
  const exported = await exportedPromise;
  expect(await exported.failure()).toBeNull();
  const payload = await readFile(await exported.path());
  expect(payload.length).toBe(2097152);
  const library = await (await fetch(hub.server + '/api/library', { headers: { Cookie: hub.cookie } })).json();
  const file = library.files.find(file => file.filename === exported.suggestedFilename());
  const checksum = await (await fetch(hub.server + `/api/files/${file.id}/checksum`, { headers: { Cookie: hub.cookie } })).json();
  expect(createHash('sha256').update(payload).digest('hex')).toBe(checksum.sha256);
  await page.getByRole('button', { name: 'Delete file', exact: true }).first().click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#saved-list .card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete file', exact: true }).first().click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#saved-list .card')).toHaveCount(1);
  // Deleting a saved copy must not delete or modify the PC's originals.
  const originals = await (await fetch(hub.server + '/api/library', { headers: { Cookie: hub.cookie } })).json();
  expect(originals.files).toHaveLength(2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect PC', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#pair-view')).toBeVisible();
  await complete(page, 1);
  await page.reload();
  await complete(page, 1);
});

test('shared phone rejects bad checksum and resumes after the fault is removed', async ({ page, hub }, testInfo) => {
  await pair(page, hub);
  await queue(page, false);
  await page.route('**/api/files/*/checksum', async route => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, sha256: '0'.repeat(64) } });
  });
  await page.getByRole('button', { name: 'Download queued files', exact: true }).click();
  await expect(page.locator('#queue-list')).toContainText('Checksum verification failed', { timeout: 20000 });
  await capture(page, testInfo, 'verification-failed');
  await page.getByRole('button', { name: 'Downloaded', exact: true }).click();
  await expect(page.locator('#saved-list .card')).toHaveCount(0);
  await page.unroute('**/api/files/*/checksum');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await complete(page, 1);
});

test('shared phone retains partial bytes across reload and resumes with a range', async ({ page, hub }) => {
  await pair(page, hub);
  await queue(page, false);
  await page.getByRole('button', { name: 'Download queued files', exact: true }).click();
  await expect.poll(() => received(page)).toBeGreaterThan(0);
  const before = await received(page);
  await page.reload();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.locator('#queue-list')).toContainText('paused');
  expect(await received(page)).toBeGreaterThanOrEqual(before);
  const rangePromise = page.waitForRequest(request => request.headers().range?.startsWith('bytes=') && request.headers().range !== 'bytes=0-65535');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  expect((await rangePromise).headers().range).toMatch(/^bytes=[1-9]\d*-/);
  await complete(page, 1);
});

test('shared demo never pretends a file was downloaded', async ({ page, hub }) => {
  await page.goto(hub.server + '/app/');
  await page.getByRole('button', { name: 'Try demo library', exact: true }).click();
  await queue(page);
  await expect(page.locator('#demo-warning')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download queued files', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Downloaded', exact: true }).click();
  await expect(page.locator('#saved-list .card')).toHaveCount(0);
});

test('shared phone also works through the native JavaScript message transport', async ({ page, hub }) => {
  // Exercise the actual WK message/reply JavaScript path on Windows. The receiver
  // is still the explicitly labeled generated-file adapter, not native iOS code.
  await page.addInitScript({ path: fileURLToPath(new URL('../testing/windows-host.js', import.meta.url)) });
  await page.addInitScript(() => {
    window.__testMessages = [];
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { hub: { postMessage(input) {
      window.__testMessages.push({ id: input.id, method: input.method });
      WindowsHubHost.call(input.method, input.params).then(
        value => window.__hubReply({ id: input.id, ok: true, value }),
        error => window.__hubReply({ id: input.id, ok: false, error: error.message })
      );
    } } } } });
  });
  await pair(page, hub, true);
  await queue(page, false);
  await page.getByRole('button', { name: 'Download queued files', exact: true }).click();
  await complete(page, 1);
  const messages = await page.evaluate(() => window.__testMessages);
  expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);
  for (const method of ['connection', 'pair', 'library', 'queue', 'transfers', 'addQueue', 'start']) expect(messages.some(message => message.method === method)).toBe(true);
});
