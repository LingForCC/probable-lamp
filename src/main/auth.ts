/**
 * JWT (server auth) login flow.
 *
 * In real mode: exchanges the configured long-lived RingCentral JWT
 * (RC_JWT) for an access token using the jwt-bearer grant.
 *
 * In mock mode: installs a fake token set and resolves immediately.
 */
import type { RealClientTokenOps } from '../shared/client/ringcentral.js'
import type { MockMessagingClient } from '../shared/client/mock/mockClient.js'
import type { IMessagingClient, TokenSet } from '../shared/types.js'

export interface AuthControllerOptions {
  client: IMessagingClient
  isMock: boolean
  /** Long-lived RingCentral JWT (RC_JWT). Required in real mode. */
  jwt?: string
}

export class AuthController {
  constructor(private readonly opts: AuthControllerOptions) {}

  /**
   * Run the login flow. Resolves with the token set, or rejects on error.
   */
  async login(): Promise<TokenSet> {
    if (this.opts.isMock) {
      const mock = this.opts.client as unknown as MockMessagingClient
      const tokens = mock.login()
      this.opts.client.setTokens(tokens)
      return tokens
    }

    if (!this.opts.jwt) {
      throw new Error('RC_JWT is not configured; cannot log in.')
    }

    const client = this.opts.client as unknown as IMessagingClient & RealClientTokenOps
    const tokens = await client.exchangeJwtForToken(this.opts.jwt)
    this.opts.client.setTokens(tokens)
    return tokens
  }
}
