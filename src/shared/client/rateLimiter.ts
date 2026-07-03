/**
 * Token-bucket rate limiter for the RingCentral REST API.
 *
 * RingCentral groups endpoints into rate-limit buckets (per app, per 60s):
 *   - Auth   (/oauth/token):  5 / min
 *   - Heavy: 10 / min
 *   - Medium (most Glip):    40 / min
 *   - Light:                  50 / min
 *
 * The limiter is time-injected (`now()` / `setTimeoutFn`) so it can be
 * unit-tested deterministically without real timers.
 */

export type RateLimitGroup = 'auth' | 'heavy' | 'medium' | 'light'

export const RATE_LIMITS: Readonly<Record<RateLimitGroup, { capacity: number; intervalMs: number }>> = {
  auth: { capacity: 5, intervalMs: 60_000 },
  heavy: { capacity: 10, intervalMs: 60_000 },
  medium: { capacity: 40, intervalMs: 60_000 },
  light: { capacity: 50, intervalMs: 60_000 }
}

export interface RateLimiterOptions {
  group: RateLimitGroup
  /** Capacity override (defaults to the group's capacity). */
  capacity?: number
  /** Refill interval override in ms. */
  intervalMs?: number
  /** Inject clock (tests). */
  now?: () => number
  /** Inject scheduler (tests). When omitted, resolves immediately and uses real setTimeout for backoff. */
  schedule?: (fn: () => void, ms: number) => void
}

export interface RateLimitDecision {
  /** Whether the call is allowed immediately. */
  allowed: boolean
  /** ms to wait before retry when not allowed. */
  retryAfterMs: number
  /** Remaining tokens after this call (if allowed). */
  remaining: number
}

/**
 * A leaky-bucket limiter. `take()` either permits a call or returns a wait time.
 * `waitForTake()` resolves once a token is available.
 */
export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => void

  constructor(opts: RateLimiterOptions) {
    const limits = RATE_LIMITS[opts.group]
    this.capacity = opts.capacity ?? limits.capacity
    this.intervalMs = opts.intervalMs ?? limits.intervalMs
    this.tokens = this.capacity
    this.now = opts.now ?? (() => Date.now())
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.lastRefill = this.now()
  }

  /** Refill tokens proportional to elapsed time. */
  private refill(): void {
    const t = this.now()
    const elapsed = t - this.lastRefill
    if (elapsed <= 0) return
    const refillRate = this.capacity / this.intervalMs // tokens per ms
    const refilled = elapsed * refillRate
    this.tokens = Math.min(this.capacity, this.tokens + refilled)
    this.lastRefill = t
  }

  /** Check whether one token can be consumed; returns a decision without consuming. */
  check(): RateLimitDecision {
    this.refill()
    if (this.tokens >= 1) {
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(this.tokens - 1) }
    }
    // Need to wait for one token to accrue.
    const refillRate = this.capacity / this.intervalMs
    const need = 1 - this.tokens
    const retryAfterMs = Math.ceil(need / refillRate)
    return { allowed: false, retryAfterMs, remaining: 0 }
  }

  /** Consume a token. Returns true if allowed, false otherwise. */
  take(): boolean {
    const decision = this.check()
    if (decision.allowed) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** Resolve once a token is available (consuming it). */
  async waitForTake(): Promise<void> {
    // Tight loop in case the injected scheduler is synchronous (tests).
    // In production it uses real setTimeout.
    for (;;) {
      if (this.take()) return
      const decision = this.check()
      await new Promise<void>((resolve) => this.schedule(resolve, decision.retryAfterMs))
    }
  }

  /** Snapshot of remaining tokens (after refill). */
  get remainingTokens(): number {
    this.refill()
    return this.tokens
  }
}

/**
 * Registry of limiters keyed by group, so callers can simply ask for a group.
 */
export class RateLimiterRegistry {
  private readonly limiters = new Map<RateLimitGroup, RateLimiter>()
  private readonly opts: { now?: () => number; schedule?: (fn: () => void, ms: number) => void }

  constructor(
    opts: { now?: () => number; schedule?: (fn: () => void, ms: number) => void } = {}
  ) {
    this.opts = opts
  }

  get(group: RateLimitGroup): RateLimiter {
    let limiter = this.limiters.get(group)
    if (!limiter) {
      limiter = new RateLimiter({ group, ...this.opts })
      this.limiters.set(group, limiter)
    }
    return limiter
  }

  /** Convenience: wait for a token in the given group. */
  async waitFor(group: RateLimitGroup): Promise<void> {
    await this.get(group).waitForTake()
  }
}
