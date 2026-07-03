import { describe, expect, it } from 'vitest'
import {
  RateLimiter,
  RateLimiterRegistry,
  RATE_LIMITS
} from '../../src/shared/client/rateLimiter'
import type { RateLimitGroup } from '../../src/shared/client/rateLimiter'

/**
 * A virtual scheduler: maintains a fake clock and a queue of pending callbacks.
 * `advance(ms)` runs every callback whose deadline has elapsed, in order.
 */
function virtualClock() {
  let now = 1_000_000
  const queue: Array<{ deadline: number; fn: () => void }> = []
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
      // Run due callbacks in deadline order.
      const due = queue.filter((q) => q.deadline <= now).sort((a, b) => a.deadline - b.deadline)
      for (const q of due) {
        const idx = queue.indexOf(q)
        if (idx >= 0) queue.splice(idx, 1)
        q.fn()
      }
    },
    schedule: (fn: () => void, ms: number) => queue.push({ deadline: now + ms, fn })
  }
}

describe('RateLimiter', () => {
  it('uses the documented capacities per group', () => {
    expect(RATE_LIMITS.auth.capacity).toBe(5)
    expect(RATE_LIMITS.heavy.capacity).toBe(10)
    expect(RATE_LIMITS.medium.capacity).toBe(40)
    expect(RATE_LIMITS.light.capacity).toBe(50)
    // All intervals are 60s.
    for (const g of Object.keys(RATE_LIMITS) as RateLimitGroup[]) {
      expect(RATE_LIMITS[g].intervalMs).toBe(60_000)
    }
  })

  it('allows up to capacity immediately, then blocks', () => {
    const clk = virtualClock()
    const lim = new RateLimiter({ group: 'medium', now: clk.now })
    for (let i = 0; i < 40; i++) expect(lim.take()).toBe(true)
    expect(lim.take()).toBe(false)
  })

  it('refills tokens over time', () => {
    const clk = virtualClock()
    const lim = new RateLimiter({ group: 'auth', now: clk.now }) // 5 / min
    for (let i = 0; i < 5; i++) expect(lim.take()).toBe(true)
    expect(lim.take()).toBe(false)
    // 5 tokens over 60s = 1 token per 12s. After 12s one token should be back.
    clk.advance(12_000)
    expect(lim.take()).toBe(true)
    expect(lim.take()).toBe(false)
  })

  it('check() reports retryAfterMs when blocked', () => {
    const clk = virtualClock()
    const lim = new RateLimiter({ group: 'auth', now: clk.now }) // 5/min => 12s/token
    for (let i = 0; i < 5; i++) lim.take()
    const decision = lim.check()
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBeGreaterThan(0)
    expect(decision.retryAfterMs).toBeLessThanOrEqual(12_000)
  })

  it('waitForTake() resolves once a token is available after backoff', async () => {
    const clk = virtualClock()
    const lim = new RateLimiter({
      group: 'auth',
      now: clk.now,
      schedule: clk.schedule
    })
    for (let i = 0; i < 5; i++) lim.take()
    let resolved = false
    const p = lim.waitForTake().then(() => {
      resolved = true
    })
    // Not resolved immediately.
    await Promise.resolve()
    expect(resolved).toBe(false)
    // Advance past the refill time for one token.
    clk.advance(13_000)
    await p
    expect(resolved).toBe(true)
  })

  it('cap and interval can be overridden', () => {
    const clk = virtualClock()
    const lim = new RateLimiter({
      group: 'medium',
      capacity: 2,
      intervalMs: 1000,
      now: clk.now
    })
    expect(lim.take()).toBe(true)
    expect(lim.take()).toBe(true)
    expect(lim.take()).toBe(false)
    clk.advance(1000)
    expect(lim.take()).toBe(true)
  })
})

describe('RateLimiterRegistry', () => {
  it('returns a shared limiter per group', () => {
    const reg = new RateLimiterRegistry()
    expect(reg.get('auth')).toBe(reg.get('auth'))
    expect(reg.get('auth')).not.toBe(reg.get('medium'))
  })

  it('waitFor convenience waits for a token', async () => {
    const clk = virtualClock()
    const reg = new RateLimiterRegistry({ now: clk.now, schedule: clk.schedule })
    const auth = reg.get('auth')
    for (let i = 0; i < 5; i++) auth.take()
    let done = false
    const p = reg.waitFor('auth').then(() => (done = true))
    clk.advance(13_000)
    await p
    expect(done).toBe(true)
  })
})
