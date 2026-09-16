import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3498',
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: 'node scripts/preview.mjs',
    url: 'http://127.0.0.1:3498',
    reuseExistingServer: false,
    timeout: 30000,
  },
})
