/**
 * BrowserWindow factory for the main app window.
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

/** True when running under the vite dev server (electron-vite sets this). */
export function isDev(): boolean {
  return Boolean(process.env['ELECTRON_RENDERER_URL'])
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'RC Messenger',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Open external links (http/https) in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (isDev()) {
    const url = process.env['ELECTRON_RENDERER_URL']
    if (url) void win.loadURL(url)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
