import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT || '4173';

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  expect: {
    timeout: 15000
  },
  fullyParallel: true,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `node tests/static-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/crime_map.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
