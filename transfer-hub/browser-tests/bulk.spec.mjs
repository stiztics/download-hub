import { test, expect } from '@playwright/test';
import { startFixture } from '../testing/fixture-server.mjs';

async function open(page, fixture) {
  await page.addInitScript(() => {
    window.__externalFolderFixture = { id: 'bulk-source', name: 'Generated SSD', available: true, files: [1, 2].map(episode => ({ id: 'bulk-video-' + episode, series: 'Bulk series', title: 'Bulk series', season: 'S0' + episode, episode, filename: 'Episode ' + episode + '.mp4', relativePath: 'Bulk series/S0' + episode + '/Episode ' + episode + '.mp4', bytes: 2097152 })) };
  });
  await page.goto(fixture.server + '/app/');
}
async function start(page, direction, move = false) {
  await page.getByRole('button', { name: direction === 'import' ? 'Import all from SSD' : 'Export all to SSD', exact: true }).click();
  await expect(page.locator('#bulk-dialog')).toBeVisible();
  if (move) await page.getByLabel('Remove originals after verified copying', { exact: true }).check();
  await page.getByRole('button', { name: move ? 'Move all' : 'Copy all', exact: true }).click();
  if (move) { await expect(page.locator('#confirm-text')).toContainText('removed only after'); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); }
}
async function complete(page, count = 2) {
  await expect(page.locator('#bulk-summary')).toContainText(count + ' / ' + count + ' files · completed', { timeout: 15000 });
}
test('recursive bulk import and export work offline, keep originals, and skip imported files on repeat', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await open(page, fixture); await start(page, 'import'); await complete(page);
    const first = await page.evaluate(() => Hub.call('library'));
    expect(first).toHaveLength(2);
    expect(first.every(file => file.locations.some(source => source.kind === 'phone') && file.locations.some(source => source.kind === 'drive'))).toBe(true);
    await page.reload(); await expect(page.locator('#library-summary')).toContainText('2 episodes');
    await page.getByRole('button', { name: 'Import all from SSD', exact: true }).click();
    await expect(page.locator('#bulk-plan')).toContainText('0 videos');
    await expect(page.getByRole('button', { name: 'Copy all', exact: true })).toBeDisabled();
    await page.locator('#bulk-dismiss').click();
    await page.evaluate(() => { window.__externalFolderFixture = { id: 'bulk-destination', name: 'Destination SSD', available: true, files: [] }; });
    await start(page, 'export'); await complete(page);
    const exported = await page.evaluate(() => Hub.call('library'));
    expect(exported.every(file => file.locations.some(source => source.kind === 'phone') && file.locations.some(source => source.driveID === 'bulk-destination'))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('bulk-completed.png'), fullPage: true });
  } finally { await fixture.close(); }
});
test('cancel preserves completed copies and retry after reload continues the unfinished batch', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await open(page, fixture); await page.evaluate(() => { window.__bulkCopyDelay = 100; }); await start(page, 'import');
    await expect.poll(() => page.evaluate(async () => (await Hub.call('bulkStatus')).completed)).toBe(1);
    await page.getByRole('button', { name: 'Cancel copying', exact: true }).click();
    await expect(page.locator('#bulk-summary')).toContainText('canceled');
    await page.reload();
    await expect(page.locator('#bulk-summary')).toContainText('1 / 2');
    await page.getByRole('button', { name: 'Retry unfinished files', exact: true }).click(); await complete(page);
    const rows = await page.evaluate(() => Hub.call('library'));
    expect(rows.every(file => file.locations.filter(source => source.kind === 'phone').length === 1)).toBe(true);
  } finally { await fixture.close(); }
});
test('moves require confirmation and collision errors preserve the source copy', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await open(page, fixture); await start(page, 'import'); await complete(page);
    await page.evaluate(() => { window.__externalFolderFixture = { id: 'move-destination', name: 'Move SSD', available: true, files: [], existing: { 'Episode 1.mp4': 'different bytes' } }; });
    await start(page, 'export', true);
    await expect(page.locator('#bulk-summary')).toContainText('completed with errors', { timeout: 15000 });
    await expect(page.locator('#bulk-errors')).toContainText('different file already exists');
    const before = await page.evaluate(() => Hub.call('library'));
    expect(before.find(file => file.filename === 'Episode 1.mp4').locations.some(source => source.kind === 'phone')).toBe(true);
    expect(before.find(file => file.filename === 'Episode 2.mp4').locations.some(source => source.kind === 'phone')).toBe(false);
    await page.evaluate(() => { window.__externalFolderFixture.existing = {}; });
    await page.getByRole('button', { name: 'Retry unfinished files', exact: true }).click(); await complete(page);
    const after = await page.evaluate(() => Hub.call('library'));
    expect(after.every(file => !file.locations.some(source => source.kind === 'phone') && file.locations.some(source => source.driveID === 'move-destination'))).toBe(true);
  } finally { await fixture.close(); }
});

test('already imported videos can be moved by verifying the existing phone copies', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await open(page, fixture); await start(page, 'import'); await complete(page);
    await page.getByRole('button', { name: 'Import all from SSD', exact: true }).click();
    await expect(page.locator('#bulk-plan')).toContainText('0 videos');
    await page.getByLabel('Remove originals after verified copying', { exact: true }).check();
    await expect(page.locator('#bulk-plan')).toContainText('2 videos');
    await page.getByRole('button', { name: 'Move all', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await complete(page);
    const files = await page.evaluate(() => Hub.call('library'));
    expect(files.every(file => file.locations.filter(source => source.kind === 'phone').length === 1 && !file.locations.some(source => source.kind === 'drive'))).toBe(true);
  } finally { await fixture.close(); }
});
