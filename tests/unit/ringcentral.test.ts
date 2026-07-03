import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  RingCentralClient,
  RingCentralAuthError,
  RingCentralError,
  SERVER_URLS
} from '../../src/shared/client/ringcentral'
import { RateLimiterRegistry } from '../../src/shared/client/rateLimiter'

interface MockResponse {
  status: number
  json: unknown
  headers?: Record<string, string>
}

function makeResponse(mock: MockResponse): Response {
  const blob = JSON.stringify(mock.json)
  const headers = new Map<string, string>(Object.entries(mock.headers ?? {}))
  return {
    ok: mock.status >= 200 && mock.status < 300,
    status: mock.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => blob,
    json: async () => JSON.parse(blob)
  } as unknown as Response
}

interface RecordedRequest {
  url: string
  method: string
  body?: string
  headers: Record<string, string>
}

/**
 * Test harness with an always-recording fetch that serves queued responses.
 * Responses are matched by URL substring (in insertion order); a special
 * `'*'` entry matches any URL (used as a default/fallback).
 */
function makeClient(opts: { now?: () => number; refreshMarginMs?: number } = {}) {
  const requests: RecordedRequest[] = []
  const queue: Array<{ match: string; resp: MockResponse }> = []

  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const headers: Record<string, string> = {}
      const initHeaders = init.headers as Record<string, string> | undefined
      if (initHeaders) for (const [k, v] of Object.entries(initHeaders)) headers[k] = v
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : undefined,
        headers
      })
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i]
        if (entry.match === '*' || url.includes(entry.match)) {
          queue.splice(i, 1)
          return makeResponse(entry.resp)
        }
      }
      return makeResponse({ status: 404, json: { message: 'no mock for ' + url } })
    }
  )

  // Limiter with synchronous scheduler so waitForTake never blocks the test.
  const limiter = new RateLimiterRegistry({ now: opts.now ?? Date.now, schedule: (fn) => fn() })

  const client = new RingCentralClient({
    server: 'sandbox',
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: 'http://localhost/cb',
    fetch: fetch as unknown as typeof fetch,
    sha256: async (b) => b,
    limiter,
    refreshMarginMs: opts.refreshMarginMs ?? 0,
    now: opts.now ?? Date.now
  })

  return {
    client,
    fetch,
    requests,
    enqueue(match: string, resp: MockResponse): void {
      queue.push({ match, resp })
    },
    /** Direct access for tests that want mockImplementation semantics. */
    mock: fetch.mock
  }
}

const NOW = 1_700_000_000_000

describe('RingCentralClient URLs', () => {
  it('uses the sandbox base url', () => {
    const { client } = makeClient()
    expect(client.baseUrl).toBe(SERVER_URLS.sandbox)
  })
})

describe('RingCentralClient auth', () => {
  it('exchanges an authorization code for tokens', async () => {
    const env = makeClient({ now: () => NOW })
    env.enqueue('/oauth/token', {
      status: 200,
      json: {
        access_token: 'AT',
        refresh_token: 'RT',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token_expires_in: 604800,
        scope: 'TeamMessaging',
        owner_id: '123'
      }
    })
    const tokens = await env.client.exchangeCodeForToken('code', 'verifier')
    expect(tokens.access_token).toBe('AT')
    expect(tokens.obtainedAt).toBe(NOW)
    env.client.setTokens(tokens)
    expect(env.client.getTokens()?.access_token).toBe('AT')
    const authCall = env.requests.find((r) => r.url.endsWith('/restapi/oauth/token'))
    expect(authCall).toBeDefined()
    expect(authCall!.body).toContain('grant_type=authorization_code')
    expect(authCall!.body).toContain('code=code')
    expect(authCall!.body).toContain('code_verifier=verifier')
  })

  it('throws RingCentralAuthError on 401', async () => {
    const env = makeClient()
    env.enqueue('/oauth/token', { status: 401, json: { error: 'invalid_grant' } })
    await expect(env.client.exchangeCodeForToken('bad', 'v')).rejects.toBeInstanceOf(
      RingCentralAuthError
    )
  })

  it('refreshes tokens via refresh_token grant', async () => {
    const env = makeClient({ now: () => NOW })
    env.client.setTokens({
      access_token: 'old',
      refresh_token: 'rt',
      token_type: 'bearer',
      expires_in: 0,
      refresh_token_expires_in: 604800,
      obtainedAt: NOW - 10_000
    })
    env.enqueue('/oauth/token', {
      status: 200,
      json: {
        access_token: 'newAT',
        refresh_token: 'newRT',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token_expires_in: 604800
      }
    })
    const refreshed = await env.client.refreshTokens()
    expect(refreshed.access_token).toBe('newAT')
    expect(env.requests[0].body).toContain('grant_type=refresh_token')
    expect(env.requests[0].body).toContain('refresh_token=rt')
  })
})

describe('RingCentralClient REST', () => {
  let now: number
  beforeEach(() => {
    now = 1_700_000_000_000
  })

  function authedClient(marginMs = 60_000) {
    const env = makeClient({ now: () => now, refreshMarginMs: marginMs })
    env.client.setTokens({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token_expires_in: 604800,
      obtainedAt: 1_700_000_000_000
    })
    return env
  }

  it('GET /glip/persons/~me with bearer auth', async () => {
    const env = authedClient()
    env.enqueue('/glip/persons/~me', { status: 200, json: { id: '111', firstName: 'Me' } })
    const me = await env.client.getMe()
    expect(me.id).toBe('111')
    expect(env.requests[0].url).toContain('/glip/persons/~me')
    expect(env.requests[0].headers.Authorization).toBe('Bearer AT')
  })

  it('listChats parses records + nextPageToken (navigation)', async () => {
    const env = authedClient()
    env.enqueue('/glip/chats', {
      status: 200,
      json: {
        records: [{ id: 'c1', type: 'Team', name: 'Eng' }],
        navigation: { nextPageToken: 'page2' }
      }
    })
    const res = await env.client.listChats()
    expect(res.records).toHaveLength(1)
    expect(res.records[0].name).toBe('Eng')
    expect(res.nextPageToken).toBe('page2')
    expect(env.requests[0].url).toContain('recordCount=250')
  })

  it('listPosts hits /glip/chats/{id}/posts with recordCount + pageToken', async () => {
    const env = authedClient()
    env.enqueue('/glip/chats/c1/posts', {
      status: 200,
      json: {
        records: [{ id: 'p1', groupId: 'c1', text: 'hi' }],
        paging: { nextPageToken: 'tok' }
      }
    })
    const res = await env.client.listPosts('c1', { recordCount: 25, pageToken: 'abc' })
    expect(res.records[0].id).toBe('p1')
    expect(res.nextPageToken).toBe('tok')
    expect(env.requests[0].url).toContain('/glip/chats/c1/posts')
    expect(env.requests[0].url).toContain('recordCount=25')
    expect(env.requests[0].url).toContain('pageToken=abc')
  })

  it('sendPost POSTs text + mentions + attachments', async () => {
    const env = authedClient()
    env.enqueue('/glip/chats/c1/posts', {
      status: 200,
      json: { id: 'p9', groupId: 'c1', text: 'hello', creationTime: 't' }
    })
    const sent = await env.client.sendPost('c1', 'hello', {
      mentions: [{ type: 'Person', id: '123' }],
      attachments: [{ type: 'Card', title: 't' }]
    })
    expect(sent.id).toBe('p9')
    const body = JSON.parse(env.requests[0].body!)
    expect(body.text).toBe('hello')
    expect(body.mentions).toHaveLength(1)
    expect(body.attachments).toHaveLength(1)
    expect(env.requests[0].method).toBe('POST')
  })

  it('editPost PUTs and deletePost DELETEs', async () => {
    const env = authedClient()
    env.enqueue('/posts/p1', { status: 200, json: { id: 'p1', text: 'edited' } })
    env.enqueue('/posts/p1', { status: 204, json: '' })
    const edited = await env.client.editPost('c1', 'p1', 'edited')
    expect(edited.text).toBe('edited')
    await env.client.deletePost('c1', 'p1')
    expect(env.requests[0].method).toBe('PUT')
    expect(env.requests[0].url).toContain('/glip/chats/c1/posts/p1')
    expect(env.requests[1].method).toBe('DELETE')
  })

  it('searchPosts uses searchText query param', async () => {
    const env = authedClient()
    env.enqueue('/glip/posts', {
      status: 200,
      json: { records: [{ id: 'x', text: 'needle' }] }
    })
    const res = await env.client.searchPosts('needle')
    expect(res).toHaveLength(1)
    expect(env.requests[0].url).toContain('searchText=needle')
  })

  it('markChatRead POSTs to /glip/chats/{id}/read', async () => {
    const env = authedClient()
    env.enqueue('/glip/chats/c1/read', { status: 204, json: '' })
    await env.client.markChatRead('c1')
    expect(env.requests[0].method).toBe('POST')
    expect(env.requests[0].url).toContain('/glip/chats/c1/read')
  })

  it('proactively refreshes when access token is near expiry', async () => {
    // access token obtained far in the past relative to `now` => expired.
    const env = authedClient(60_000)
    env.client.setTokens({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token_expires_in: 604800,
      obtainedAt: now - 3_600_000 // expired by 1h
    })
    env.enqueue('/oauth/token', {
      status: 200,
      json: {
        access_token: 'freshAT',
        refresh_token: 'freshRT',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token_expires_in: 604800
      }
    })
    env.enqueue('/glip/persons/~me', { status: 200, json: { id: 'me' } })

    const me = await env.client.getMe()
    expect(me.id).toBe('me')
    // First request = refresh, second = REST call with the new token.
    expect(env.requests[0].body).toContain('grant_type=refresh_token')
    expect(env.requests[1].headers.Authorization).toBe('Bearer freshAT')
  })

  it('retries once on 429 then succeeds', async () => {
    const env = authedClient()
    // First REST call returns 429, second returns 200. Both match the same URL.
    env.enqueue('/glip/persons/~me', { status: 429, json: {}, headers: { 'retry-after': '0' } })
    env.enqueue('/glip/persons/~me', { status: 200, json: { id: 'me' } })
    const me = await env.client.getMe()
    expect(me.id).toBe('me')
    const restCalls = env.requests.filter((r) => r.url.includes('/glip/persons/~me'))
    expect(restCalls).toHaveLength(2)
  })

  it('throws RingCentralError on non-401 failure', async () => {
    const env = authedClient()
    env.enqueue('/glip/persons/~me', { status: 500, json: { message: 'boom' } })
    await expect(env.client.getMe()).rejects.toBeInstanceOf(RingCentralError)
  })
})
