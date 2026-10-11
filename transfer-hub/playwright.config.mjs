import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  outputDir: './.test-results/browser',
  timeout: 25000,
  expect: { timeout: 8000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'transfer-hub/.test-results/report', open: 'never' }]],
  use: { headless: true, acceptDownloads: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'phone-chromium', use: { ...devices['iPhone 15 Pro'], browserName: 'chromium' } },
    { name: 'phone-webkit', use: { ...devices['iPhone 15 Pro'], browserName: 'webkit' } }
  ]
});
