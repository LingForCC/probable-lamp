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
import type { Sha256 } from './pkce.js'

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
  redirectUri?: string
  limiter: RateLimiterRegistry
  /** Only required for real mode. */
  createSocket?: WebSocketFactory
  /** Only required for real mode (PKCE code_challenge). */
  sha256?: Sha256
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

  if (!opts.clientId || !opts.redirectUri || !opts.createSocket || !opts.sha256) {
    throw new Error(
      'Real API mode requires clientId, redirectUri, createSocket, and sha256.'
    )
  }

  const client = new RingCentralClient({
    server: opts.server,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    redirectUri: opts.redirectUri,
    limiter: opts.limiter,
    sha256: opts.sha256,
    fetch: opts.fetch,
    onTokensChanged: opts.onTokensChanged
  })

  const realtime = new RingCentralSocket({
    createSocket: opts.createSocket,
    getToken: () => client.getTokens()?.access_token ?? null,
    refreshToken: async () => {
      try {
        return (await client.refreshTokens()).access_token
      } catch {
        return null
      }
    },
    onReconnect: opts.onReconnect
  })

  return { client, realtime, isMock: false }
}
