/**
 * Persisted application state with encrypted token storage.
 *
 * Non-secret settings (theme, apiMode, server) are stored in plaintext.
 * The OAuth token set is encrypted with Electron's safeStorage (platform
 * keychain) before being persisted, so tokens at rest are never plaintext.
 */
import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { ServerConfig, TokenSet } from '../shared/types.js'

export interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  server: 'sandbox' | 'production'
  apiMode: 'mock' | 'real'
}

export interface PersistedState {
  settings: AppSettings
  /** base64 of safeStorage-encrypted TokenSet JSON, or null */
  encryptedTokens: string | null
  /**
   * Per-chat read-state watermarks (chatId -> ISO timestamp of the newest
   * message the user has seen). Plaintext: no secrets, same exposure as the
   * message previews already shown in the sidebar. Drives local unread counts.
   */
  readStates: Record<string, string>
}

const DEFAULT_STATE: PersistedState = {
  settings: { theme: 'system', server: 'sandbox', apiMode: 'mock' },
  encryptedTokens: null,
  readStates: {}
}

export class AppStore {
  private readonly store: Store<PersistedState>

  /**
   * @param cwd Optional directory for the persisted JSON file. Production leaves
   * it unset (electron-store's default userData dir); tests inject a temp dir
   * for isolation.
   */
  constructor(cwd?: string) {
    this.store = new Store<PersistedState>({
      name: 'rc-messenger',
      defaults: DEFAULT_STATE,
      ...(cwd ? { cwd } : {})
    })
  }

  get settings(): AppSettings {
    return this.store.get('settings', DEFAULT_STATE.settings)
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.settings, ...patch }
    this.store.set('settings', next)
    return next
  }

  /** Whether safeStorage encryption is available on this platform. */
  canEncrypt(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  saveTokens(tokens: TokenSet | null): void {
    if (!tokens) {
      this.store.set('encryptedTokens', null)
      return
    }
    const json = JSON.stringify(tokens)
    if (this.canEncrypt()) {
      const enc = safeStorage.encryptString(json)
      this.store.set('encryptedTokens', enc.toString('base64'))
    } else {
      // Fallback: plaintext (development only). Logged once at startup.
      this.store.set('encryptedTokens', json)
    }
  }

  loadTokens(): TokenSet | null {
    const raw = this.store.get('encryptedTokens', null)
    if (!raw) return null
    try {
      let json: string
      if (this.canEncrypt()) {
        const buf = Buffer.from(raw, 'base64')
        json = safeStorage.decryptString(buf)
      } else {
        json = raw // plaintext fallback
      }
      return JSON.parse(json) as TokenSet
    } catch {
      return null
    }
  }

  clearTokens(): void {
    this.store.set('encryptedTokens', null)
  }

  /** All per-chat read-state watermarks (chatId -> ISO timestamp). */
  getReadStates(): Record<string, string> {
    return this.store.get('readStates', DEFAULT_STATE.readStates)
  }

  /** Persist/overwrite a single chat's read-state watermark. */
  setReadState(chatId: string, isoTime: string): void {
    this.store.set(`readStates.${chatId}`, isoTime)
  }

  /** Merge persisted settings with a runtime config (env-derived). */
  resolveConfig(env: ServerConfig): ServerConfig {
    const settings = this.settings
    return {
      server: settings.server ?? env.server,
      apiMode: settings.apiMode ?? env.apiMode,
      clientId: env.clientId,
      redirectUri: env.redirectUri
    }
  }
}
