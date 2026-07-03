import { defineConfig } from '@playwright/test'

/**
 * Playwright config for E2E tests that drive the packaged Electron app.
 * All E2E tests run with RC_API_MODE=mock (set via the test:e2e script) so they
 * exercise the full UI without real RingCentral credentials or network.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
})
