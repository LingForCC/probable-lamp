import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  RingCentralClient,
  RingCentralAuthError,
  RingCentralError,
  SERVER_URLS
} from '../../src/shared/client/ringcentral'
import type { TokenSet } from '../../src/shared/types'
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
function makeClient(opts: { now?: () => number } = {}) {
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
    jwt: 'test-jwt',
    clientId: 'cid',
    clientSecret: 'csecret',
    fetch: fetch as unknown as typeof fetch,
    limiter,
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
  it('exchanges a JWT for tokens via the jwt-bearer grant', async () => {
    const env = makeClient({ now: () => NOW })
    env.enqueue('/oauth/token', {
      status: 200,
      json: {
        access_token: 'AT',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'TeamMessaging',
        owner_id: '123'
      }
    })
    const tokens = await env.client.exchangeJwtForToken('my-jwt')
    expect(tokens.access_token).toBe('AT')
    expect(tokens.obtainedAt).toBe(NOW)
    expect(env.client.getTokens()?.access_token).toBe('AT')
    const authCall = env.requests.find((r) => r.url.endsWith('/restapi/oauth/token'))
    expect(authCall).toBeDefined()
    expect(authCall!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(authCall!.body).toContain('assertion=my-jwt')
  })

  it('throws RingCentralAuthError on 401', async () => {
    const env = makeClient()
    env.enqueue('/oauth/token', { status: 401, json: { error: 'invalid_grant' } })
    await expect(env.client.exchangeJwtForToken('bad')).rejects.toBeInstanceOf(
      RingCentralAuthError
    )
  })

  it('fires onTokensChanged when tokens are set or exchanged', async () => {
    const seen: Array<TokenSet | null> = []
    const limiter = new RateLimiterRegistry({ now: () => NOW, schedule: (fn) => fn() })
    const client = new RingCentralClient({
      server: 'sandbox',
      jwt: 'test-jwt',
      fetch: (vi.fn(async () => makeResponse({ status: 200, json: {} })) as unknown) as typeof fetch,
      limiter,
      now: () => NOW,
      onTokensChanged: (t) => seen.push(t)
    })
    const tokens: TokenSet = {
      access_token: 'A',
      token_type: 'bearer',
      expires_in: 3600,
      obtainedAt: NOW
    }
    client.setTokens(tokens)
    expect(seen).toEqual([tokens])
    // explicit clear → null
    client.setTokens(null)
    expect(seen[seen.length - 1]).toBeNull()
  })
})

describe('RingCentralClient REST', () => {
  let now: number
  beforeEach(() => {
    now = 1_700_000_000_000
  })

  function authedClient() {
    const env = makeClient({ now: () => now })
    env.client.setTokens({
      access_token: 'AT',
      token_type: 'bearer',
      expires_in: 3600,
      obtainedAt: 1_700_000_000_000
    })
    return env
  }

  it('GET /account/~/extension/~ (getMe) with bearer auth, maps to GlipPerson', async () => {
    const env = authedClient()
    env.enqueue('/account/~/extension/~', {
      status: 200,
      json: {
        id: 111,
        status: 'Enabled',
        contact: { firstName: 'Me', lastName: 'Self', email: 'me@example.com' },
        profileImage: { uri: 'https://example.com/avatar.png' }
      }
    })
    const me = await env.client.getMe()
    expect(me.id).toBe('111')
    expect(me.firstName).toBe('Me')
    expect(me.email).toBe('me@example.com')
    expect(me.avatar).toBe('https://example.com/avatar.png')
    expect(env.requests[0].url).toContain('/account/~/extension/~')
    expect(env.requests[0].headers.Authorization).toBe('Bearer AT')
  })

  it('listRecentChats parses records (recent endpoint has no navigation token)', async () => {
    const env = authedClient()
    env.enqueue('/team-messaging/v1/recent/chats', {
      status: 200,
      json: {
        records: [{ id: 'c1', type: 'Team', name: 'Eng' }]
      }
    })
    const res = await env.client.listRecentChats()
    expect(res.records).toHaveLength(1)
    expect(res.records[0].name).toBe('Eng')
    expect(res.nextPageToken).toBeUndefined()
    expect(env.requests[0].url).toContain('recordCount=250')
  })

  it('listPosts hits /team-messaging/v1/chats/{id}/posts with recordCount + pageToken', async () => {
    const env = authedClient()
    env.enqueue('/team-messaging/v1/chats/c1/posts', {
      status: 200,
      json: {
        records: [{ id: 'p1', groupId: 'c1', text: 'hi' }],
        paging: { nextPageToken: 'tok' }
      }
    })
    const res = await env.client.listPosts('c1', { recordCount: 25, pageToken: 'abc' })
    expect(res.records[0].id).toBe('p1')
    expect(res.nextPageToken).toBe('tok')
    expect(env.requests[0].url).toContain('/team-messaging/v1/chats/c1/posts')
    expect(env.requests[0].url).toContain('recordCount=25')
    expect(env.requests[0].url).toContain('pageToken=abc')
  })

  it('sendPost POSTs text + mentions + attachments', async () => {
    const env = authedClient()
    env.enqueue('/team-messaging/v1/chats/c1/posts', {
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
    expect(env.requests[0].url).toContain('/team-messaging/v1/chats/c1/posts/p1')
    expect(env.requests[1].method).toBe('DELETE')
  })

  it('searchPosts fans out per-chat (no global search endpoint) and merges hits', async () => {
    const env = authedClient()
    // searchPosts first lists recent chats, then searches each per-chat.
    env.enqueue('/team-messaging/v1/recent/chats', {
      status: 200,
      json: { records: [{ id: 'c1', type: 'Team', name: 'A' }, { id: 'c2', type: 'Team', name: 'B' }] }
    })
    env.enqueue('/team-messaging/v1/chats/c1/posts', {
      status: 200,
      json: { records: [{ id: 'x', chatId: 'c1', text: 'needle' }] }
    })
    env.enqueue('/team-messaging/v1/chats/c2/posts', {
      status: 200,
      json: { records: [{ id: 'y', chatId: 'c2', text: 'needle here' }] }
    })
    const res = await env.client.searchPosts('needle')
    expect(res).toHaveLength(2)
    // `chatId` from the REST response is normalized onto `groupId`.
    expect(res.map((p) => p.groupId).sort()).toEqual(['c1', 'c2'])
    const searched = env.requests.map((r) => r.url).filter((u) => u.includes('searchText=needle'))
    expect(searched).toHaveLength(2)
  })

  it('markChatRead is a no-op on the wire (no working TM endpoint; local watermark is source of truth)', async () => {
    const env = authedClient()
    await env.client.markChatRead('c1')
    // No HTTP request should be issued at all.
    expect(env.requests).toHaveLength(0)
  })

  it('retries once on 429 then succeeds', async () => {
    const env = authedClient()
    // First REST call returns 429, second returns 200. Both match the same URL.
    env.enqueue('/account/~/extension/~', { status: 429, json: {}, headers: { 'retry-after': '0' } })
    env.enqueue('/account/~/extension/~', {
      status: 200,
      json: { id: 42, contact: { firstName: 'Me' } }
    })
    const me = await env.client.getMe()
    expect(me.id).toBe('42')
    const restCalls = env.requests.filter((r) => r.url.includes('/account/~/extension/~'))
    expect(restCalls).toHaveLength(2)
  })

  it('throws RingCentralError on non-401 failure', async () => {
    const env = authedClient()
    env.enqueue('/account/~/extension/~', { status: 500, json: { message: 'boom' } })
    await expect(env.client.getMe()).rejects.toBeInstanceOf(RingCentralError)
  })
})
