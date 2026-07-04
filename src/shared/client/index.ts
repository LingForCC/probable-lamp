/**
 * Client factory: returns the right messaging client + realtime source based on
 * the configured API mode (`mock` or `real`).
 */

import type {
  IMessagingClient,
  RealtimeSubscription,
  TokenSet
} from '../types.js'
import { MockMessagingClient, type MockOptions } from './mock/mockClient.js'
import {
  RingCentralClient,
  type ServerEnv
} from './ringcentral.js'
import { RingCentralSocket, type WebSocketFactory } from './websocket.js'
import type { RateLimiterRegistry } from './rateLimiter.js'

export interface ClientFactoryResult {
  client: IMessagingClient
  realtime: RealtimeSubscription
  isMock: boolean
}

export interface ClientFactoryOptions {
  apiMode: 'mock' | 'real'
  server: ServerEnv
  clientId?: string
  clientSecret?: string
  /** Long-lived RingCentral JWT used to mint access tokens. Required for real mode. */
  jwt?: string
  limiter: RateLimiterRegistry
  /** Only required for real mode. */
  createSocket?: WebSocketFactory
  /** fetch override (tests). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Called whenever the real client's token set changes (re-persist to store). */
  onTokensChanged?: (tokens: TokenSet | null) => void
  /**
   * Called when the realtime socket reconnects after a drop (not on initial
   * connect). Used to trigger a missed-event reconcile. Real mode only.
   */
  onReconnect?: () => void
  mockOptions?: MockOptions
}

export function createClients(opts: ClientFactoryOptions): ClientFactoryResult {
  if (opts.apiMode === 'mock') {
    const mock = new MockMessagingClient(opts.mockOptions ?? {})
    return { client: mock, realtime: mock, isMock: true }
  }

  if (!opts.jwt || !opts.createSocket) {
    throw new Error('Real API mode requires jwt and createSocket.')
  }

  const client = new RingCentralClient({
    server: opts.server,
    jwt: opts.jwt,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    limiter: opts.limiter,
    fetch: opts.fetch,
    onTokensChanged: opts.onTokensChanged
  })

  const realtime = new RingCentralSocket({
    createSocket: opts.createSocket,
    getToken: () => client.getTokens()?.access_token ?? null,
    // JWTs are not refreshable; if the access token is missing we cannot mint
    // a new one here. In practice this never fires because the JWT is exchanged
    // at startup, before the socket connects.
    refreshToken: async () => null,
    onReconnect: opts.onReconnect
  })

  return { client, realtime, isMock: false }
}
