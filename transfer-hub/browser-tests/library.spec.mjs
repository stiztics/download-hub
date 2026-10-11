import { test, expect } from '@playwright/test';
import { startFixture } from '../testing/fixture-server.mjs';

async function pair(page, fixture) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('PC address', { exact: true }).fill(fixture.server);
  await page.getByLabel('Pairing code', { exact: true }).fill(fixture.code);
  await page.getByRole('button', { name: 'Connect to PC', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
}
test('device library starts without pairing and preserves its catalog and organization offline', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await page.goto(fixture.server + '/app/');
    await expect(page.locator('#library-view')).toBeVisible();
    await expect(page.locator('#pair-view')).toBeHidden();
    await pair(page, fixture);
    await page.getByRole('button', { name: 'Browse Demo Series', exact: true }).click();
    await page.getByRole('button', { name: 'Browse season S01', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Demo Episode 1.bin', exact: true }).click();
    await page.getByLabel('Series / collection', { exact: true }).fill('My collection');
    await page.getByLabel('Season / folder', { exact: true }).fill('Season 2');
    await page.getByRole('button', { name: 'Save organization', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Browse My collection', exact: true })).toBeVisible();
    await page.route('**/api/**', route => route.abort());
    await page.reload();
    await expect(page.getByRole('button', { name: 'Browse My collection', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse My collection', exact: true }).click();
    await page.getByRole('button', { name: 'Browse season Season 2', exact: true }).click();
    await page.getByRole('button', { name: 'Details for Demo Episode 1.bin', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play episode', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Queue transfer', exact: true }).click();
    await expect(page.locator('#queue-list')).toContainText('waiting');
    await page.reload();
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    await expect(page.locator('#queue-list')).toContainText('Demo Episode 1.bin');
    await expect(page.locator('#queue-list')).toContainText('waiting');
  } finally { await fixture.close(); }
});

test('SSD catalog persists, exposes destination choices, and survives drive removal without false deduplication', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await page.addInitScript(() => {
      window.__externalFolderFixture = { id: 'generated-drive', name: 'Test SSD', files: [{ id: 'different-ssd-file', series: 'Demo Series', title: 'Test Season', season: 'S01', episode: 1, filename: 'Demo Episode 1.bin', bytes: 2097152 }] };
    });
    await page.goto(fixture.server + '/app/');
    await pair(page, fixture);
    await page.getByRole('button', { name: 'Add SSD folder', exact: true }).click();
    await expect(page.locator('#library-summary')).toContainText('3 episodes');
    await page.getByLabel('Storage', { exact: true }).selectOption('drive');
    await page.getByRole('button', { name: 'Browse Demo Series', exact: true }).click();
    await page.getByRole('button', { name: 'Browse season S01', exact: true }).click();
    await expect(page.locator('#episode-list .episode')).toHaveCount(1);
    await expect(page.locator('#episode-list')).toContainText('On SSD · Test SSD');
    await page.getByRole('button', { name: 'Play Demo Episode 1.bin', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('cannot play this video format');
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    await page.getByLabel('Transfer destination', { exact: true }).selectOption('generated-drive');
    await expect(page.locator('#destination-note')).toContainText('keep this app open');
    await page.reload();
    await expect(page.locator('#library-summary')).toContainText('3 episodes');
    await page.evaluate(() => { window.__externalFolderFixture.available = false; });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Rescan', exact: true }).click();
    await expect(page.locator('#drive-list')).toContainText('Disconnected');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByLabel('Storage', { exact: true }).selectOption('drive');
    await page.getByRole('button', { name: 'Browse Demo Series', exact: true }).click();
    await page.getByRole('button', { name: 'Browse season S01', exact: true }).click();
    await expect(page.locator('#episode-list')).toContainText('disconnected');
    await page.getByRole('button', { name: 'Details for Demo Episode 1.bin', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play episode', exact: true })).toBeDisabled();
    await expect(page.locator('#library-summary')).toContainText('3 episodes');
    const screenshot = test.info().outputPath('external-library.png');
    await page.locator('#episode-close').click();
    await page.screenshot({ path: screenshot });
    await test.info().attach('external-library', { path: screenshot, contentType: 'image/png' });
  } finally { await fixture.close(); }
});
