/**
 * Custom RingCentral Team Messaging (Glip) REST client.
 *
 * No SDK dependency. Implements:
 *   - JWT bearer grant: exchange a long-lived RC JWT for an access token
 *   - REST calls with bearer auth, JSON, and a 429-aware retry layer
 *   - Glip endpoints: persons/~me, chats, teams, posts CRUD, files, search
 *
 * Network IO (`fetch`) is injected so the client can be unit-tested with fakes
 * and run in either main (Node) or renderer (browser).
 *
 * NOTE: `executeAuth` (the JWT exchange) hits the strict Auth rate-limit bucket
 * (5/min); the REST endpoints hit Medium (40/min). The injected
 * `RateLimiterRegistry` enforces both client-side, and the 429 retry layer is a
 * second line of defense for server-driven throttling.
 *
 * Auth model: the long-lived JWT configured via RC_JWT is exchanged once (at
 * startup or on retry) for an access token, which is then used as the Bearer
 * credential for REST and as the `?token=` for the WebSocket gateway. JWTs are
 * not refreshable; if the access token ever stops working, the JWT is
 * re-exchanged.
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

/**
 * RingCentral removed its Developer Sandbox on 2025-01-01; production is now the
 * only environment (see https://community.ringcentral.com/developer-platform-apis-integrations-5/important-changes-coming-to-our-developer-sandbox-9893).
 * The legacy `platform.devtest.ringcentral.com` host no longer resolves. We keep
 * a `sandbox` key for backward compatibility with persisted/existing config but
 * alias it to the production host so any old `RC_SERVER=sandbox` setting keeps
 * working instead of failing with a DNS error.
 */
export const SERVER_URLS = {
  sandbox: 'https://platform.ringcentral.com',
  production: 'https://platform.ringcentral.com'
} as const

export type ServerEnv = keyof typeof SERVER_URLS

export const WS_GATEWAY = 'wss://ws-api.ringcentral.com'

/** Injected fetch — matches the global fetch signature. */
export type FetchLike = typeof fetch

export interface RingCentralClientOptions {
  server: ServerEnv
  /** Long-lived RingCentral JWT used to mint access tokens (RC_JWT). */
  jwt: string
  /** Optional client id/secret retained for app identity / future use. */
  clientId?: string
  clientSecret?: string
  fetch?: FetchLike
  limiter: RateLimiterRegistry
  /** clock for token-expiry math (tests) */
  now?: () => number
  /**
   * Called whenever the token set changes (exchange, explicit set). Lets the
   * main process re-persist tokens to the encrypted store after a JWT exchange
   * so a crash doesn't lose the freshly minted token.
   */
  onTokensChanged?: (tokens: TokenSet | null) => void
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
 * Narrowed interface a controller can use to reach the JWT/token methods that
 * only exist on the real client. Cast to this only in real mode.
 */
export interface RealClientTokenOps {
  exchangeJwtForToken(jwt: string): Promise<TokenSet>
}

/**
 * Subset of the `/restapi/v1.0/account/~/extension/~` response used by getMe().
 * The extension `id` is the same identifier Glip uses for `creatorId`, so
 * mapping it onto `GlipPerson.id` keeps own-message detection correct.
 */
interface ExtensionInfo {
  id: number | string
  status?: string
  contact?: {
    firstName?: string
    lastName?: string
    email?: string
  }
  profileImage?: {
    uri?: string
  }
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

  constructor(private readonly opts: RingCentralClientOptions) {
    this.fetcher = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
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

  /**
   * Exchange the configured long-lived JWT for an access token using the
   * jwt-bearer grant (Auth rate bucket). The returned access token is used as
   * the Bearer credential for REST and as the `?token=` for the WebSocket.
   */
  async exchangeJwtForToken(jwt: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
    const tokens = await this.executeAuth(body)
    // Persist via setTokens so the onTokensChanged hook re-persists to the
    // encrypted store (a freshly minted token should survive a crash).
    this.setTokens(tokens)
    return tokens
  }

  /**
   * POST to /restapi/oauth/token respecting the Auth rate limit.
   *
   * RingCentral authenticates the *app* (client) via an HTTP Basic header
   * carrying `client_id:client_secret` — even for the JWT-bearer grant. Omitting
   * it yields `invalid_client`. The JWT in the body then authenticates the user
   * / extension. See https://community.ringcentral.com/developer-platform-apis-integrations-5/jwt-error-error-client-authentication-is-required-node-sdk-6290.
   */
  private async executeAuth(body: URLSearchParams): Promise<TokenSet> {
    await this.opts.limiter.waitFor('auth')
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
    if (this.opts.clientId && this.opts.clientSecret) {
      const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64')
      headers.Authorization = `Basic ${basic}`
    }
    const res = await this.fetcher(`${this.baseUrl}/restapi/oauth/token`, {
      method: 'POST',
      headers,
      body: body.toString()
    })
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1')
      await delay(retry * 1000)
      // single retry after backoff
      return this.executeAuth(body)
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
   * Run a REST call with: rate-limit gating, bearer auth, and a 429-aware
   * retry layer.
   */
  private async rest<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
  ): Promise<T> {
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
      return this.rest<T>(method, path, opts)
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

  /**
   * Return the current user as a GlipPerson.
   *
   * RingCentral removed the `/glip/persons/~me` convenience endpoint (it now
   * 400s with "personId contains invalid value '~me'"). The canonical way to
   * identify the authenticated user is the Extension endpoint
   * `/restapi/v1.0/account/~/extension/~`, whose `id` is the same person id
   * used as Glip posts' `creatorId` (so own-message detection keeps working).
   * We map the extension fields onto GlipPerson here.
   */
  async getMe(): Promise<GlipPerson> {
    const ext = await this.rest<ExtensionInfo>('GET', '/account/~/extension/~')
    const contact = ext.contact
    return {
      id: String(ext.id),
      firstName: contact?.firstName,
      lastName: contact?.lastName,
      email: contact?.email,
      avatar: ext.profileImage?.uri,
      status: ext.status
    }
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
