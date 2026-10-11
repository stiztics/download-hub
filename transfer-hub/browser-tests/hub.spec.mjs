import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startFixture } from '../testing/fixture-server.mjs';

const test = base.extend({
  hub: async ({}, use) => {
    const hub = await startFixture();
    try { await use(hub); } finally { await hub.close(); }
  },
  runtimeErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'No JavaScript runtime errors').toEqual([]);
  }, { auto: true }]
});

const route = testInfo => testInfo.project.name.startsWith('phone') ? '/phone' : '/';
async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(name + '.png');
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
async function openLibrary(page, hub, testInfo) {
  await page.goto(hub.server + route(testInfo));
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
}
async function openSeries(page) {
  await page.getByRole('button', { name: 'Browse Demo Series', exact: true }).click();
  await expect(page.locator('#season-panel')).toBeVisible();
}
async function queueSelected(page) {
  await page.locator('#send-button').click();
  await expect(page.locator('#selection-bar')).toBeHidden();
  await page.locator('[data-view="queue"]:visible').click();
  await expect(page.locator('#queue-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
}

test('library search, empty results and phone layout', async ({ page, hub }, testInfo) => {
  await openLibrary(page, hub, testInfo);
  await expect(page.locator('#file-total')).toHaveText('2');
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('nothing-matches');
  await expect(page.getByRole('heading', { name: 'No matching downloads' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('demo');
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  await capture(page, testInfo, 'library');
});

test('select, queue, deduplicate and remove through the UI', async ({ page, hub }, testInfo) => {
  await openLibrary(page, hub, testInfo);
  await openSeries(page);
  await page.getByRole('button', { name: 'Select all shown', exact: true }).click();
  await expect(page.locator('#selection-count')).toHaveText('2 files selected');
  await queueSelected(page);
  await expect(page.locator('.queue-row')).toHaveCount(2);
  await page.locator('[data-view="library"]:visible').click();
  await page.getByRole('button', { name: 'Select all shown', exact: true }).click();
  await queueSelected(page);
  await expect(page.locator('.queue-row')).toHaveCount(2);
  await capture(page, testInfo, 'queue');
  await page.getByRole('button', { name: 'Remove Demo Episode 1.bin from queue', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('#queue-summary')).toContainText('1 pending');
});

test('browser pairing rejects invalid code, then downloads byte-perfect file', async ({ page, hub }, testInfo) => {
  // Model a remote phone: local administration is refused, as with Tailscale forwarding.
  // All pairing, session and download requests still use the real server.
  await page.route('**/api/local-session', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Local PC only"}' }));
  await page.goto(hub.server + route(testInfo));
  await expect(page.locator('#pair-gate')).toBeVisible();
  await page.getByLabel('Pairing code', { exact: true }).fill('00000000');
  await page.getByRole('button', { name: 'Connect this device', exact: false }).click();
  await expect(page.getByRole('status')).toContainText('invalid or expired');
  await expect(page.locator('#pair-gate')).toBeVisible();
  await page.getByLabel('Pairing code', { exact: true }).fill(hub.code);
  await page.getByRole('button', { name: 'Connect this device', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
  await openSeries(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.episode-row').first().getByRole('link', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe('Demo Episode 1.bin');
  const payload = await readFile(await download.path());
  expect(payload.length).toBe(2 * 1024 * 1024);
  const library = await (await page.request.get(hub.server + '/api/library')).json();
  const checksum = await (await page.request.get(hub.server + `/api/files/${library.files.find(f => f.filename === download.suggestedFilename()).id}/checksum`)).json();
  expect(createHash('sha256').update(payload).digest('hex')).toBe(checksum.sha256);
  // Browsers cannot confirm an iOS offline save; a browser download cannot invent a receipt.
  const queue = await (await page.request.get(hub.server + '/api/queue')).json();
  expect(queue).toEqual([]);
  await capture(page, testInfo, 'paired-phone');
});

test('revoked phone loses access and returns to pairing', async ({ page, hub }, testInfo) => {
  await page.route('**/api/local-session', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Local PC only"}' }));
  await page.goto(hub.server + route(testInfo));
  await page.getByLabel('Pairing code', { exact: true }).fill(hub.code);
  await page.getByRole('button', { name: 'Connect this device', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
  const response = await fetch(hub.server + '/api/devices', { method: 'DELETE', headers: { Cookie: hub.cookie } });
  expect(response.status).toBe(200);
  await expect(page.locator('#pair-gate')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
});
