/**
 * OAuth Authorization Code + PKCE login flow.
 *
 * In real mode: opens a BrowserWindow at the RingCentral authorize URL, waits
 * for the redirect to our `redirect_uri`, extracts the `code`, and exchanges it
 * for tokens using the PKCE code_verifier.
 *
 * In mock mode: installs a fake token set and resolves immediately.
 */
import { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import type { RealClientTokenOps } from '../shared/client/ringcentral.js'
import type { MockMessagingClient } from '../shared/client/mock/mockClient.js'
import { createCodeVerifier } from '../shared/client/pkce.js'
import type { IMessagingClient, TokenSet } from '../shared/types.js'

/** Generate a short random state token to bind the authorize round-trip. */
export function createState(): string {
  return randomBytes(16).toString('hex')
}

/** Extract ?code= and ?state= from a redirect URL. */
export function parseRedirect(
  url: string
): { code?: string; state?: string; error?: string } {
  try {
    const u = new URL(url)
    return {
      code: u.searchParams.get('code') ?? undefined,
      state: u.searchParams.get('state') ?? undefined,
      error: u.searchParams.get('error') ?? undefined
    }
  } catch {
    return {}
  }
}

/**
 * Opener contract: open the authorize URL in a browser the user can interact
 * with, and resolve with the final redirect URL (the callback containing the
 * `code`). The opener is responsible for closing the browser window.
 */
export type AuthOpener = (url: string) => Promise<string>

export interface AuthControllerOptions {
  client: IMessagingClient
  isMock: boolean
}

export class AuthController {
  constructor(private readonly opts: AuthControllerOptions) {}

  /**
   * Run the login flow. Resolves with the token set, or rejects on error.
   * `opener` is injected so tests can stub the BrowserWindow.
   */
  async login(opener: AuthOpener): Promise<TokenSet> {
    if (this.opts.isMock) {
      const mock = this.opts.client as unknown as MockMessagingClient
      const tokens = mock.login()
      this.opts.client.setTokens(tokens)
      return tokens
    }

    const client = this.opts.client as unknown as IMessagingClient & RealClientTokenOps
    const state = createState()
    const verifier = createCodeVerifier()
    const { url } = await client.buildAuthorizeUrl(state, verifier)

    const finalUrl = await opener(url)
    const parsed = parseRedirect(finalUrl)
    if (parsed.error) throw new Error(`OAuth error: ${parsed.error}`)
    if (!parsed.code) throw new Error('No authorization code returned')

    const tokens = await client.exchangeCodeForToken(parsed.code, verifier)
    this.opts.client.setTokens(tokens)
    return tokens
  }
}

/**
 * Production BrowserWindow-based opener. Opens the URL, intercepts the redirect
 * to `redirectUri`, and resolves with the captured URL. Closes the window.
 */
export function openAuthWindow(redirectUri: string): AuthOpener {
  return (url: string) =>
    new Promise<string>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: { sandbox: true, contextIsolation: true }
      })

      let done = false
      const finish = (result: string | Error) => {
        if (done) return
        done = true
        try {
          win.close()
        } catch {
          /* ignore */
        }
        if (result instanceof Error) reject(result)
        else resolve(result)
      }

      win.webContents.on('will-redirect', (_e, redirectedUrl) => {
        if (redirectedUrl.startsWith(redirectUri)) finish(redirectedUrl)
      })
      win.webContents.on('will-navigate', (e, navUrl) => {
        if (navUrl.startsWith(redirectUri)) {
          e.preventDefault()
          finish(navUrl)
        }
      })

      win.on('closed', () => {
        if (!done) finish(new Error('Authentication window closed'))
      })

      void win.loadURL(url)
    })
}
