import { test, expect } from '@playwright/test';
import { startFixture } from '../testing/fixture-server.mjs';

test('search, episode selection and independent PC queue controls', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = { active: 0, paused: false, blocked: null, jobs: [] };
  const calls = [];
  const fixture = await startFixture({ fetcherClient: async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith('/search')) return { items: [{ id: 'test-title', title: 'Example anime', year: 2025, type: 'TV', episodes: 2 }], hasMore: false };
    if (route === '/titles/test-title') return { id: 'test-title', title: 'Example anime', episodes: [{ id: 'ep1', number: 1 }, { id: 'ep2', number: 2 }] };
    if (route === '/status') return state;
    if (route === '/jobs') {
      state.jobs = options.body.episodeIds.map(id => ({ id, title: 'Example anime', episode: id.slice(-1), status: 'queued' }));
      return { added: state.jobs.length, skipped: 0 };
    }
    if (route === '/control') {
      if (options.body.action === 'pause') state.paused = true;
      if (options.body.action === 'resume') state.paused = false;
      if (options.body.action === 'cancel') state.jobs.find(x => x.id === options.body.id).status = 'canceled';
      return state;
    }
    throw new Error('Unexpected fixture request: ' + route);
  } });
  try {
    await page.goto(fixture.server + (testInfo.project.name.startsWith('phone') ? '/phone' : '/'));
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('[data-view="fetcher"]:visible').click();
    await expect(page.locator('#fetcher-status')).toContainText('Fetcher online');
    await page.getByRole('searchbox', { name: 'Search AnimePahe' }).fill('Example');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Episodes', exact: true }).click();
    await expect(page.locator('#fetcher-title-name')).toHaveText('Example anime');
    await page.getByLabel('Episode 2', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Download selected to PC' }).click();
    await expect(page.locator('#fetcher-jobs .queue-row')).toHaveCount(1);
    expect(calls.find(x => x.route === '/jobs').body.episodeIds).toEqual(['ep1']);
    await page.getByRole('button', { name: 'Pause all', exact: true }).click();
    await expect(page.locator('#fetcher-status')).toHaveText('PC downloads paused');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('#fetcher-status')).toContainText('Fetcher online');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#fetcher-jobs')).toContainText('canceled');
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath('fetcher.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('isolated demo never contacts the real fetcher', async ({ page }) => {
  const fixture = await startFixture();
  try {
    await page.goto(fixture.server);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('[data-view="fetcher"]:visible').click();
    await expect(page.locator('#fetcher-status')).toContainText('disabled in this isolated test preview');
  } finally { await fixture.close(); }
});
