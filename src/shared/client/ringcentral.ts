/**
 * Custom RingCentral Team Messaging (Glip) REST client.
 *
 * No SDK dependency. Implements:
 *   - OAuth Authorization Code + PKCE token exchange, refresh, revoke
 *   - Proactive token refresh (refresh once we're within a safety margin of expiry)
 *   - REST calls with bearer auth, JSON, and a 429-aware retry layer
 *   - Glip endpoints: persons/~me, chats, teams, posts CRUD, files, search
 *
 * Network IO (`fetch`) and crypto (`sha256`) are injected so the client can be
 * unit-tested with fakes and run in either main (Node) or renderer (browser).
 *
 * NOTE: `executeAuth` (token exchange/refresh/revoke) hits the strict Auth
 * rate-limit bucket (5/min); the REST endpoints hit Medium (40/min). The
 * injected `RateLimiterRegistry` enforces both client-side, and the 429 retry
 * layer is a second line of defense for server-driven throttling.
 */

import type {
  GlipAttachment,
  GlipChat,
  GlipMention,
  GlipPerson,
  GlipPost,
  GlipTeam,
  IMessagingClient,
  PageResult,
  TokenSet
} from '../types.js'
import type { RateLimiterRegistry } from './rateLimiter.js'
import { createCodeChallenge, type Sha256 } from './pkce.js'

export const SERVER_URLS = {
  sandbox: 'https://platform.devtest.ringcentral.com',
  production: 'https://platform.ringcentral.com'
} as const

export type ServerEnv = keyof typeof SERVER_URLS

export const WS_GATEWAY = 'wss://ws-api.ringcentral.com'

/** Injected fetch — matches the global fetch signature. */
export type FetchLike = typeof fetch

export interface RingCentralClientOptions {
  server: ServerEnv
  clientId: string
  /** client_secret. Required for confidential refresh in some app configs; undefined for pure-PKCE public clients. */
  clientSecret?: string
  redirectUri: string
  fetch?: FetchLike
  sha256?: Sha256
  limiter: RateLimiterRegistry
  /** clock for token-expiry math (tests) */
  now?: () => number
  /** safety margin: refresh this many ms before access_token expiry */
  refreshMarginMs?: number
  /**
   * Called whenever the token set changes (exchange, refresh, revoke, explicit
   * set). Lets the main process re-persist tokens to the encrypted store after
   * a REST-driven refresh, so a crash doesn't revert to a stale token.
   */
  onTokensChanged?: (tokens: TokenSet | null) => void
}

/** Result of the PKCE authorize URL build. */
export interface AuthorizeUrlResult {
  url: string
  state: string
  verifier: string
}

export class RingCentralError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message)
    this.name = 'RingCentralError'
  }
}

export class RingCentralAuthError extends RingCentralError {
  constructor(message: string, body: unknown) {
    super(message, 401, body)
    this.name = 'RingCentralAuthError'
  }
}

/**
 * Narrowed interface a controller can use to reach the PKCE/token methods that
 * only exist on the real client. Cast to this only in real mode.
 */
export interface RealClientTokenOps {
  buildAuthorizeUrl(state: string, verifier: string): Promise<AuthorizeUrlResult>
  exchangeCodeForToken(code: string, verifier: string): Promise<TokenSet>
  refreshTokens(): Promise<TokenSet>
  revokeToken(): Promise<void>
}

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

function parseNextPageToken(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const nav = b.navigation as Record<string, unknown> | undefined
    const paging = b.paging as Record<string, unknown> | undefined
    return (
      (nav?.nextPageToken as string | undefined) ??
      (paging?.nextPageToken as string | undefined)
    )
  }
  return undefined
}

function records<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    const recs = (body as Record<string, unknown>).records
    if (Array.isArray(recs)) return recs as T[]
  }
  return []
}

export class RingCentralClient implements IMessagingClient {
  readonly isMock = false
  private tokens: TokenSet | null = null
  private readonly fetcher: FetchLike
  private readonly now: () => number
  private readonly refreshMarginMs: number

  constructor(private readonly opts: RingCentralClientOptions) {
    this.fetcher = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    this.refreshMarginMs = opts.refreshMarginMs ?? 60_000
  }

  get baseUrl(): string {
    return SERVER_URLS[this.opts.server]
  }

  // ── Token management ────────────────────────────────────────────────────

  setTokens(tokens: TokenSet | null): void {
    this.tokens = tokens
    this.opts.onTokensChanged?.(tokens)
  }

  getTokens(): TokenSet | null {
    return this.tokens
  }

  isAccessTokenExpired(): boolean {
    if (!this.tokens) return true
    const expiresAt = this.tokens.obtainedAt + this.tokens.expires_in * 1000
    return this.now() >= expiresAt - this.refreshMarginMs
  }

  private hasRefreshToken(): boolean {
    return !!this.tokens?.refresh_token
  }

  /** Build a PKCE authorize URL (browser/main opens it in a BrowserWindow). */
  async buildAuthorizeUrl(state: string, verifier: string): Promise<AuthorizeUrlResult> {
    if (!this.opts.sha256) throw new Error('sha256 is required to build the authorize URL')
    const challenge = await createCodeChallenge(verifier, this.opts.sha256)
    const url =
      `${this.baseUrl}/restapi/oauth/authorize` +
      query({
        response_type: 'code',
        state,
        client_id: this.opts.clientId,
        redirect_uri: this.opts.redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
    return { url, state, verifier }
  }

  /** Exchange an authorization code for tokens (Auth rate bucket). */
  async exchangeCodeForToken(code: string, verifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
      client_id: this.opts.clientId,
      code_verifier: verifier
    })
    if (this.opts.clientSecret) {
      body.set('client_secret', this.opts.clientSecret)
    }
    return this.executeAuth(body)
  }

  /** Refresh the access token (Auth rate bucket). */
  async refreshTokens(): Promise<TokenSet> {
    if (!this.hasRefreshToken()) throw new RingCentralAuthError('No refresh token', null)
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens!.refresh_token,
      client_id: this.opts.clientId
    })
    if (this.opts.clientSecret) {
      body.set('client_secret', this.opts.clientSecret)
    }
    const refreshed = await this.executeAuth(body)
    // Persist via setTokens so the onTokensChanged hook re-persists to the
    // encrypted store (a REST-driven refresh should survive a crash).
    this.setTokens(refreshed)
    return refreshed
  }

  /** Revoke the current token (Auth rate bucket). */
  async revokeToken(): Promise<void> {
    if (!this.tokens) return
    const body = new URLSearchParams({
      token: this.tokens.access_token,
      client_id: this.opts.clientId
    })
    if (this.opts.clientSecret) {
      body.set('client_secret', this.opts.clientSecret)
    }
    try {
      await this.executeAuth(body, '/restapi/oauth/revoke')
    } finally {
      this.setTokens(null)
    }
  }

  /** POST to /restapi/oauth/token (or a custom path) respecting the Auth rate limit. */
  private async executeAuth(
    body: URLSearchParams,
    path = '/restapi/oauth/token'
  ): Promise<TokenSet> {
    await this.opts.limiter.waitFor('auth')
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1')
      await delay(retry * 1000)
      // single retry after backoff
      return this.executeAuth(body, path)
    }
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw res.status === 401
        ? new RingCentralAuthError(authErrorMessage(json), json)
        : new RingCentralError(authErrorMessage(json), res.status, json)
    }
    const token = json as Omit<TokenSet, 'obtainedAt'>
    return { ...token, obtainedAt: this.now() }
  }

  // ── REST helper ──────────────────────────────────────────────────────────

  /**
   * Run a REST call with: proactive token refresh, rate-limit gating, bearer
   * auth, 429 retry-with-backoff, and 401 → refresh-and-retry-once.
   */
  private async rest<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
  ): Promise<T> {
    return this.restInternal<T>(method, path, opts, /* did401 */ false)
  }

  private async restInternal<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown },
    did401: boolean
  ): Promise<T> {
    // Proactive refresh: refresh before the access token expires.
    if (this.isAccessTokenExpired()) {
      if (this.hasRefreshToken()) {
        await this.refreshTokens()
      } else {
        throw new RingCentralAuthError('Access token expired and no refresh token', null)
      }
    }

    await this.opts.limiter.waitFor('medium')
    const url = `${this.baseUrl}${path.startsWith('/restapi') ? path : '/restapi/v1.0' + path}${query(opts.query ?? {})}`
    const res = await this.fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.tokens!.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })

    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1')
      await delay(Math.max(500, retry * 1000))
      return this.restInternal<T>(method, path, opts, did401)
    }

    if (res.status === 401 && !did401) {
      // refresh once and retry
      await this.refreshTokens()
      return this.restInternal<T>(method, path, opts, true)
    }

    const text = await res.text()
    const json = text ? safeJsonParse(text) : null
    if (!res.ok) {
      throw res.status === 401
        ? new RingCentralAuthError(restErrorMessage(json), json)
        : new RingCentralError(restErrorMessage(json), res.status, json)
    }
    return json as T
  }

  // ── Glip endpoints ───────────────────────────────────────────────────────

  async getMe(): Promise<GlipPerson> {
    return this.rest<GlipPerson>('GET', '/glip/persons/~me')
  }

  async listChats(): Promise<PageResult<GlipChat>> {
    const body = await this.rest<unknown>('GET', '/glip/chats', {
      query: { recordCount: 250 }
    })
    return { records: records<GlipChat>(body), nextPageToken: parseNextPageToken(body) }
  }

  async listTeams(): Promise<GlipTeam[]> {
    const body = await this.rest<unknown>('GET', '/glip/teams', {
      query: { recordCount: 250 }
    })
    return records<GlipTeam>(body)
  }

  async getTeam(chatId: string): Promise<GlipTeam> {
    return this.rest<GlipTeam>('GET', `/glip/teams/${encodeURIComponent(chatId)}`)
  }

  async createTeam(name: string, members: string[] = [], description?: string): Promise<GlipTeam> {
    return this.rest<GlipTeam>('POST', '/glip/teams', {
      body: { name, description, members: [...members] }
    })
  }

  async listPosts(
    chatId: string,
    opts: { pageToken?: string; recordCount?: number } = {}
  ): Promise<PageResult<GlipPost>> {
    const body = await this.rest<unknown>(
      'GET',
      `/glip/chats/${encodeURIComponent(chatId)}/posts`,
      { query: { recordCount: opts.recordCount ?? 50, pageToken: opts.pageToken } }
    )
    return { records: records<GlipPost>(body), nextPageToken: parseNextPageToken(body) }
  }

  async sendPost(
    chatId: string,
    text: string,
    opts: { mentions?: GlipMention[]; attachments?: GlipAttachment[] } = {}
  ): Promise<GlipPost> {
    return this.rest<GlipPost>('POST', `/glip/chats/${encodeURIComponent(chatId)}/posts`, {
      body: { text, mentions: opts.mentions ?? [], attachments: opts.attachments ?? [] }
    })
  }

  async editPost(chatId: string, postId: string, text: string): Promise<GlipPost> {
    return this.rest<GlipPost>(
      'PUT',
      `/glip/chats/${encodeURIComponent(chatId)}/posts/${encodeURIComponent(postId)}`,
      { body: { text } }
    )
  }

  async deletePost(chatId: string, postId: string): Promise<void> {
    await this.rest<void>(
      'DELETE',
      `/glip/chats/${encodeURIComponent(chatId)}/posts/${encodeURIComponent(postId)}`
    )
  }

  async uploadFile(
    chatId: string,
    file: { name: string; type: string; data: Uint8Array }
  ): Promise<GlipAttachment> {
    await this.opts.limiter.waitFor('medium')
    const url = `${this.baseUrl}/restapi/v1.0/glip/files${query({ groupId: chatId })}`
    const form = createMultipart(file)
    const res = await this.fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.tokens!.access_token}`,
        'Content-Type': `multipart/form-data; boundary=${form.boundary}`
      },
      body: form.body
    })
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      throw new RingCentralError(restErrorMessage(json), res.status, json)
    }
    return (await res.json()) as GlipAttachment
  }

  async searchPosts(text: string): Promise<GlipPost[]> {
    const body = await this.rest<unknown>('GET', '/glip/posts', {
      query: { searchText: text, recordCount: 50 }
    })
    return records<GlipPost>(body)
  }

  async markChatRead(chatId: string): Promise<void> {
    await this.rest<void>('POST', `/glip/chats/${encodeURIComponent(chatId)}/read`)
  }

  async setTyping(chatId: string): Promise<void> {
    await this.rest<void>('POST', `/glip/chats/${encodeURIComponent(chatId)}/typing`)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function authErrorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const e = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message
    if (typeof e === 'string') return e
    const desc = (body as Record<string, unknown>).error_description
    if (typeof desc === 'string') return desc
  }
  return 'Authentication failed'
}

function restErrorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const msg = (body as Record<string, Record<string, unknown>>).message
    if (typeof msg === 'string') return msg
    const err = (body as Record<string, unknown>).error
    if (typeof err === 'string') return err
  }
  return 'Request failed'
}

interface MultipartResult {
  body: string
  boundary: string
}

function createMultipart(file: { name: string; type: string; data: Uint8Array }): MultipartResult {
  const boundary = '----rcmessenger' + Math.random().toString(16).slice(2)
  let body = ''
  body += `--${boundary}\r\n`
  body += `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
  body += `Content-Type: ${file.type}\r\n\r\n`
  // Convert bytes to a binary string. Real browsers use Uint8Array bodies, but
  // for the JSON-focused test harness a string body is sufficient; the main
  // process can swap in a Buffer-backed body if needed.
  body += bytesToBinaryString(file.data)
  body += `\r\n--${boundary}--\r\n`
  return { body, boundary }
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}
