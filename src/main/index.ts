/**
 * Electron main process entry point.
 *
 * Boots the app, constructs the messaging client (real or mock based on config),
 * wires up IPC, starts the realtime subscription, and creates the main window.
 *
 * In real mode, the configured RC_JWT is exchanged for an access token
 * automatically at boot (auto-connect); no login button is required.
 */
import { app, BrowserWindow, powerMonitor } from 'electron'
import WebSocket from 'ws'
import { loadConfig } from './config.js'
import { AppStore } from './store.js'
import { CacheStore } from './cacheStore.js'
import { AuthController } from './auth.js'
import { IpcController } from './ipc.js'
import { createMainWindow } from './window.js'
import { createClients } from '../shared/client/index.js'
import type { RingCentralSocket } from '../shared/client/websocket.js'
import { RateLimiterRegistry } from '../shared/client/rateLimiter.js'
import type { AuthState } from '../shared/types.js'

// Single-instance lock so only one RC Messenger runs at a time.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const windows = new Set<BrowserWindow>()

app.whenReady().then(async () => {
  const env = loadConfig()
  const store = new AppStore()
  // Record the first-launch timestamp as early as possible. This is the seed
  // watermark for chats on a first-ever start (when there are no per-chat
  // read-states yet), so a chat is considered unread only if it has activity
  // newer than this moment. Idempotent: no-op on subsequent launches.
  store.markFirstStart()
  const resolvedConfig = store.resolveConfig({
    server: env.server,
    apiMode: env.apiMode,
    clientId: env.clientId,
    jwt: env.jwt
  })

  if (process.env.RC_API_MODE === 'mock' || resolvedConfig.apiMode === 'mock') {
    console.info('[rc-messenger] Running in MOCK mode (no real RingCentral calls).')
  } else if (!resolvedConfig.jwt) {
    console.warn('[rc-messenger] No RC_JWT set; falling back to MOCK mode.')
  }

  const limiter = new RateLimiterRegistry()
  // Offline history cache (per-chat JSON under userData/cache). Survives
  // restarts and wake; cleared on explicit logout.
  const cache = new CacheStore()
  // Holder so the socket's onReconnect callback (registered during client
  // construction, before the IpcController exists) can reach the controller.
  const controllerRef: { current: IpcController | null } = { current: null }
  const { client, realtime, isMock } = createClients({
    apiMode: resolvedConfig.apiMode,
    server: resolvedConfig.server,
    clientId: resolvedConfig.clientId,
    clientSecret: env.clientSecret,
    jwt: resolvedConfig.jwt,
    limiter,
    // Electron 31 ships Node 20, which has no global WebSocket. Use the `ws`
    // package in the main process. `ws` is API-compatible with the SocketLike
    // interface the realtime client expects (onopen/onmessage/send/close/...).
    createSocket: (url) => new WebSocket(url) as unknown as never,
    // Re-persist tokens whenever the REST client refreshes them, so a crash
    // never reverts to a stale (possibly expired) token.
    onTokensChanged: (tokens) => {
      if (!isMock) store.saveTokens(tokens)
    },
    // On a realtime reconnect, prompt the renderer to re-reconcile unread
    // (missed PostAdded events during the drop). Real mode only.
    onReconnect: () => controllerRef.current?.notifyRealtimeReconnected()
  })

  // Restore tokens on startup (used for restart continuity; in real mode the
  // auto-login below re-exchanges the JWT if no usable token is present).
  const saved = store.loadTokens()
  if (saved && !isMock) {
    client.setTokens(saved)
  }

  const auth = new AuthController({ client, isMock, jwt: resolvedConfig.jwt })

  const ctrl = IpcController.create({
    client,
    realtime,
    store,
    cache,
    auth,
    config: resolvedConfig,
    getFocusedWindow: () => BrowserWindow.getFocusedWindow()
  })
  controllerRef.current = ctrl

  // Auto-connect: in real mode, exchange the JWT at boot and broadcast the
  // resulting auth state. On failure, surface an error so the renderer can
  // offer a retry. (Mock mode waits for the user to click "Enter demo".)
  if (!isMock) {
    ctrl
      .performLogin()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Auto-login failed'
        console.error('[rc-messenger] Auto-login failed:', message)
        store.clearTokens()
        client.setTokens(null)
        ctrl.pushAuthState({ status: 'error', message } satisfies AuthState)
      })
      .finally(() => {
        const socket = realtime as RingCentralSocket
        powerMonitor.on('resume', () => {
          socket.forceReconnect()
          ctrl.notifyRealtimeReconnected()
        })
      })
  }

  const win = createMainWindow()
  windows.add(win)
  win.on('closed', () => windows.delete(win))

  // On macOS re-activate, recreate the window if it was closed.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createMainWindow()
      windows.add(w)
      w.on('closed', () => windows.delete(w))
    }
  })
})

// Quit when all windows are closed (except on macOS).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
