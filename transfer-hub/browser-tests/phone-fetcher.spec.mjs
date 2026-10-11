import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../testing/fixture-server.mjs';

async function connect(page, fixture) {
  await page.goto(fixture.server + '/app/');
  await page.getByLabel('PC address', { exact: true }).fill(fixture.server);
  await page.getByLabel('Pairing code', { exact: true }).fill(fixture.code);
  await page.getByRole('button', { name: 'Connect to PC', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Browse Demo Series', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
}

for (const nativeMessages of [false, true]) {
  test(`shared app controls the PC runner through ${nativeMessages ? 'native JavaScript messages' : 'the Windows adapter'}`, async ({ page }, testInfo) => {
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = { active: 0, paused: false, blocked: null, jobs: [] };
    let online = true;
    const fixture = await startFixture({ fetcherClient: async (route, options = {}) => {
      calls.push({ route, ...options });
      if (!online) throw Object.assign(new Error('Fetcher is offline. Run Start Fetcher.cmd on the PC.'), { status: 503 });
      if (route.startsWith('/search')) {
        const params = new URL(route, 'http://fixture').searchParams;
        return { items: params.get('page') === '2' ? [] : [{ id: 'test-title', title: 'Example <anime>', year: 2026, type: 'TV', episodes: 2 }], hasMore: params.get('page') !== '2' };
      }
      if (route === '/titles/test-title') return { id: 'test-title', title: 'Example <anime>', episodes: [{ id: 'ep1', number: 1 }, { id: 'ep2', number: 2 }] };
      if (route === '/status') return state;
      if (route === '/jobs') {
        state.jobs = options.body.episodeIds.map((id, index) => ({ id: String(index + 1).padStart(24, '0'), title: 'Example <anime>', episode: Number(id.slice(-1)), status: 'queued', bytesReceived: 0, speed: null }));
        return { added: state.jobs.length, skipped: 0 };
      }
      if (route === '/control') {
        const { action, id } = options.body;
        if (action === 'pause') state.paused = true;
        if (action === 'resume') { state.paused = false; state.blocked = null; }
        if (action === 'cancel') state.jobs.find(job => job.id === id).status = 'canceled';
        if (action === 'retry') state.jobs.find(job => job.id === id).status = 'queued';
        return state;
      }
      throw new Error('Unexpected fixture request: ' + route);
    } });
    try {
      if (nativeMessages) {
        await page.addInitScript({ path: fileURLToPath(new URL('../testing/windows-host.js', import.meta.url)) });
        await page.addInitScript(() => {
          window.__testMessages = [];
          window.webkit = { messageHandlers: { hub: { postMessage(input) {
            window.__testMessages.push(input.method);
            WindowsHubHost.call(input.method, input.params).then(
              value => window.__hubReply({ id: input.id, ok: true, value }),
              error => window.__hubReply({ id: input.id, ok: false, error: error.message })
            );
          } } } };
        });
      }
      await connect(page, fixture);
      await expect(page.locator('#fetcher-status')).toContainText('Runner online');
      const query = 'Example 日本語 & test?';
      await page.getByRole('searchbox', { name: 'Search AnimePahe' }).fill(query);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.locator('#fetcher-results')).toContainText('Example <anime>');
      expect(new URL(calls.find(call => call.route.startsWith('/search')).route, fixture.server).searchParams.get('q')).toBe(query);
      await page.getByRole('button', { name: 'Next results', exact: true }).click();
      await expect(page.locator('#fetcher-results')).toContainText('No titles found');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Episodes', exact: true }).click();
      await expect(page.locator('#fetcher-title-name')).toHaveText('Example <anime>');
      await page.getByLabel('Episode 2', { exact: true }).uncheck();
      await page.getByLabel('Collection folder', { exact: true }).fill('My Collection');
      await page.getByRole('button', { name: 'Download selected to PC', exact: true }).click();
      await expect(page.locator('#fetcher-jobs .card')).toHaveCount(1);
      await expect(page.locator('#fetcher-notice')).toContainText('1 episodes queued on PC');
      expect(calls.find(call => call.route === '/jobs').body).toEqual({ titleId: 'test-title', episodeIds: ['ep1'], series: 'My Collection' });
      const pickup = await page.evaluate(() => Hub.call('queue'));
      expect(pickup).toHaveLength(0);
      await page.getByRole('button', { name: 'Download first', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel PC download', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(calls.some(call => call.body?.action === 'cancel')).toBe(false);
      await page.getByRole('button', { name: 'Cancel PC download', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.locator('#fetcher-jobs')).toContainText('canceled');
      await page.getByRole('button', { name: 'Retry PC download', exact: true }).click();
      await expect(page.locator('#fetcher-jobs')).toContainText('queued');
      await page.getByRole('button', { name: 'Pause PC downloads', exact: true }).click();
      await expect(page.locator('#fetcher-status')).toHaveText('PC downloads paused');
      state.blocked = { code: 'VPN_REQUIRED', message: 'Reconnect the VPN on the PC.' };
      await page.getByRole('button', { name: 'Refresh PC downloads', exact: true }).click();
      await expect(page.locator('#fetcher-status')).toHaveText('Stopped: Reconnect the VPN on the PC.');
      await page.getByRole('button', { name: 'Resume PC downloads', exact: true }).click();
      await expect(page.locator('#fetcher-status')).toContainText('Runner online');
      online = false;
      await page.getByRole('button', { name: 'Refresh PC downloads', exact: true }).click();
      await expect(page.locator('#fetcher-status')).toContainText('Fetcher is offline');
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
      online = true;
      await page.getByRole('button', { name: 'Refresh PC downloads', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
      await page.reload();
      await page.getByRole('button', { name: 'Fetch', exact: true }).click();
      await expect(page.locator('#fetcher-jobs .card')).toHaveCount(1);
      const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
      if (nativeMessages) {
        const messages = await page.evaluate(() => window.__testMessages);
        expect(messages).toContain('fetcherStatus');
        // The full command flow is also checked by the server-side calls above;
        // reload intentionally resets the injected message log.
      }
      for (const action of ['prioritize', 'cancel', 'retry', 'pause', 'resume']) expect(calls.some(call => call.body?.action === action)).toBe(true);
      const path = testInfo.outputPath('phone-fetcher.png');
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach('phone-fetcher', { path, contentType: 'image/png' });
      expect(errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

test('shared app requires pairing and demo never reaches the real PC runner', async ({ page }) => {
  const calls = [];
  const fixture = await startFixture({ fetcherClient: async route => { calls.push(route); throw new Error('Should never be called'); } });
  try {
    await page.goto(fixture.server + '/app/');
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.locator('#pair-view')).toBeVisible();
    await expect(page.locator('#fetcher-view')).toBeHidden();
    await page.getByRole('button', { name: 'Try demo library', exact: true }).click();
    await expect(page.locator('#fetcher-status')).toHaveText('Demo — PC runner controls unavailable');
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Resume PC downloads', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Refresh PC downloads', exact: true }).click();
    expect(calls).toEqual([]);
  } finally { await fixture.close(); }
});
