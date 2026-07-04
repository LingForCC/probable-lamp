/**
 * Electron main process entry point.
 *
 * Boots the app, constructs the messaging client (real or mock based on config),
 * wires up IPC, starts the realtime subscription, and creates the main window.
 */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { loadConfig } from './config.js'
import { AppStore } from './store.js'
import { AuthController, openAuthWindow } from './auth.js'
import { IpcController } from './ipc.js'
import { createMainWindow } from './window.js'
import { createClients } from '../shared/client/index.js'
import type { RingCentralSocket } from '../shared/client/websocket.js'
import { RateLimiterRegistry } from '../shared/client/rateLimiter.js'
import { installNodeCrypto, nodeSha256 } from './nodeCrypto.js'

// Wire Node crypto into the pkce encoder (needed for base64 in main).
installNodeCrypto()

// Single-instance lock so only one RC Messenger runs at a time.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const windows = new Set<BrowserWindow>()

app.whenReady().then(async () => {
  const env = loadConfig()
  const store = new AppStore()
  const resolvedConfig = store.resolveConfig({
    server: env.server,
    apiMode: env.apiMode,
    clientId: env.clientId,
    redirectUri: env.redirectUri
  })

  if (process.env.RC_API_MODE === 'mock' || resolvedConfig.apiMode === 'mock') {
    console.info('[rc-messenger] Running in MOCK mode (no real RingCentral calls).')
  } else if (!resolvedConfig.clientId) {
    console.warn('[rc-messenger] No RC_CLIENT_ID set; falling back to MOCK mode.')
  }

  const limiter = new RateLimiterRegistry()
  // Holder so the socket's onReconnect callback (registered during client
  // construction, before the IpcController exists) can reach the controller.
  const controllerRef: { current: IpcController | null } = { current: null }
  const { client, realtime, isMock } = createClients({
    apiMode: resolvedConfig.apiMode,
    server: resolvedConfig.server,
    clientId: resolvedConfig.clientId,
    clientSecret: env.clientSecret,
    redirectUri: resolvedConfig.redirectUri ?? '',
    limiter,
    sha256: nodeSha256,
    createSocket: (url) => new globalThis.WebSocket(url) as unknown as never,
    // Re-persist tokens whenever the REST client refreshes them, so a crash
    // never reverts to a stale (possibly expired) token.
    onTokensChanged: (tokens) => {
      if (!isMock) store.saveTokens(tokens)
    },
    // On a realtime reconnect, prompt the renderer to re-reconcile unread
    // (missed PostAdded events during the drop). Real mode only.
    onReconnect: () => controllerRef.current?.notifyRealtimeReconnected()
  })

  // Restore tokens on startup.
  const saved = store.loadTokens()
  if (saved && !isMock) {
    client.setTokens(saved)
  }

  const auth = new AuthController({ client, isMock })

  const ctrl = IpcController.create({
    client,
    realtime,
    store,
    auth,
    config: resolvedConfig,
    openExternal: openAuthWindow(resolvedConfig.redirectUri ?? ''),
    getFocusedWindow: () => BrowserWindow.getFocusedWindow()
  })
  controllerRef.current = ctrl

  // On system wake, the realtime socket can sit stale (timers didn't tick
  // during sleep) and realtime events were missed. Force a reconnect and tell
  // the renderer to re-reconcile unread from the persisted watermark.
  if (!isMock) {
    const socket = realtime as RingCentralSocket
    powerMonitor.on('resume', () => {
      socket.forceReconnect()
      ctrl.notifyRealtimeReconnected()
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
