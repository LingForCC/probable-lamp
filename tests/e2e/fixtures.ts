import { _electron as electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Launch the packaged Electron app in MOCK mode and return the app + first page.
 * The app must be built first (see package.json `test:e2e` which runs build).
 */
export async function launchMockApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const mainPath = resolve(here, '../../out/main/index.js')
  const app = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      RC_API_MODE: 'mock',
      // Force the app to treat this as "packaged" (load built renderer files).
      NODE_ENV: 'production',
      E2E: 'true'
    },
    timeout: 60_000
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

export { expect }
