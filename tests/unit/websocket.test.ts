import { describe, expect, it } from 'vitest'
import { RingCentralSocket, READY_STATE, type SocketLike } from '../../src/shared/client/websocket'
import type { RealtimeEnvelope } from '../../src/shared/types'

/**
 * A fake WebSocket. The test can push `deliver(data)` to simulate an inbound
 * server frame and inspect what the client sent.
 */
class FakeSocket implements SocketLike {
  readyState: number = READY_STATE.CONNECTING
  onopen: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = READY_STATE.CLOSED
    this.onclose?.({})
  }

  /** Helper: simulate the server opening the connection. */
  open() {
    this.readyState = READY_STATE.OPEN
    this.onopen?.({})
  }

  /** Helper: simulate an inbound message. */
  deliver(data: string) {
    this.onmessage?.({ data })
  }
}

function virtualClock() {
  let now = 1_000_000
  const queue: Array<{ deadline: number; fn: () => void }> = []
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
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

describe('RingCentralSocket', () => {
  it('connects with the token in the URL', async () => {
    const clk = virtualClock()
    let createdUrl = ''
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: (url) => {
        createdUrl = url
        const s = new FakeSocket()
        // open on next tick
        Promise.resolve().then(() => s.open())
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999
    })
    await sock.start()
    expect(createdUrl).toContain('wss://ws-api.ringcentral.com')
    expect(createdUrl).toContain('token=AT')
    await sock.stop()
  })

  it('sends a Subscribe message on open with event filters', async () => {
    const clk = virtualClock()
    const fake = new FakeSocket()
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => fake,
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      eventFilters: ['/restapi/v1.0/glip/posts']
    })
    await sock.start()
    fake.open()
    expect(fake.sent).toHaveLength(1)
    const msg = JSON.parse(fake.sent[0])
    expect(msg.message.type).toBe('Subscribe')
    expect(msg.message.eventFilters).toContain('/restapi/v1.0/glip/posts')
    expect(msg.message.deliveryMode.transportType).toBe('WebSocket')
    await sock.stop()
  })

  it('dispatches PostAdded notifications to listeners and tracks sequenceId', async () => {
    const clk = virtualClock()
    const fake = new FakeSocket()
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => fake,
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999
    })
    const received: RealtimeEnvelope[] = []
    sock.onRealtime((env) => received.push(env))
    await sock.start()
    fake.open()

    fake.deliver(
      JSON.stringify({
        event: '/restapi/v1.0/glip/posts',
        sequenceId: 42,
        body: { eventType: 'PostAdded', id: 'p1', groupId: 'c1', text: 'hi', creatorId: 'u' }
      })
    )
    fake.deliver(
      JSON.stringify({
        event: '/restapi/v1.0/glip/posts',
        sequenceId: 43,
        body: { eventType: 'PostAdded', id: 'p2', groupId: 'c1', text: 'yo', creatorId: 'u' }
      })
    )

    expect(received.map((r) => (r.body as { id: string }).id)).toEqual(['p1', 'p2'])
    expect(sock.currentSequenceId).toBe(43)
    await sock.stop()
  })

  it('ignores ack and pong messages for realtime dispatch', async () => {
    const clk = virtualClock()
    const fake = new FakeSocket()
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => fake,
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999
    })
    const received: unknown[] = []
    sock.onRealtime((env) => received.push(env))
    await sock.start()
    fake.open()

    fake.deliver(JSON.stringify({ type: 'SubscriptionConfirmation', subscriptionId: 's1' }))
    fake.deliver(JSON.stringify({ event: 'Pong' }))
    expect(received).toHaveLength(0)
    await sock.stop()
  })

  it('reconnects after a close with backoff', async () => {
    const clk = virtualClock()
    let createCount = 0
    const sockets: FakeSocket[] = []
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => {
        createCount++
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000
    })
    await sock.start()
    sockets[0].open()
    expect(createCount).toBe(1)
    // Simulate the server closing the connection.
    sockets[0].readyState = READY_STATE.CLOSED
    sockets[0].onclose?.({})
    // Advance past the backoff; a new socket should be created.
    clk.advance(1_500)
    expect(createCount).toBe(2)
    await sock.stop()
  })

  it('sends sessionRecovery with the last sequenceId when reconnecting', async () => {
    const clk = virtualClock()
    const sockets: FakeSocket[] = []
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000
    })
    await sock.start()
    sockets[0].open()
    // Push a notification so sequenceId advances.
    sockets[0].deliver(
      JSON.stringify({
        event: '/restapi/v1.0/glip/posts',
        sequenceId: 77,
        body: { eventType: 'PostAdded', id: 'x', groupId: 'c', text: 'a', creatorId: 'u' }
      })
    )
    // Reconnect.
    sockets[0].readyState = READY_STATE.CLOSED
    sockets[0].onclose?.({})
    clk.advance(1_500)
    sockets[1].open()
    const sub = JSON.parse(sockets[1].sent[0])
    expect(sub.message.sessionRecovery.sequenceId).toBe(77)
    await sock.stop()
  })

  it('onReconnect fires on a reconnect, NOT on the initial connect', async () => {
    const clk = virtualClock()
    const sockets: FakeSocket[] = []
    let reconnects = 0
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000,
      onReconnect: () => {
        reconnects++
      }
    })
    await sock.start()
    sockets[0].open() // initial connect — must NOT fire onReconnect
    expect(reconnects).toBe(0)
    // Force a reconnect.
    sockets[0].readyState = READY_STATE.CLOSED
    sockets[0].onclose?.({})
    clk.advance(1_500)
    sockets[1].open() // second connect — IS a reconnect
    expect(reconnects).toBe(1)
    await sock.stop()
  })

  it('forceReconnect closes an open socket and is a no-op when stopped', async () => {
    const clk = virtualClock()
    const sockets: FakeSocket[] = []
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000
    })
    await sock.start()
    sockets[0].open()
    let closed = false
    sockets[0].onclose = () => {
      closed = true
    }
    sock.forceReconnect()
    expect(closed).toBe(true)
    // After stop, forceReconnect is a no-op (no throw, no reconnect scheduled).
    await sock.stop()
    expect(() => sock.forceReconnect()).not.toThrow()
  })

  it('refreshes the token before connecting when getToken returns null', async () => {
    const clk = virtualClock()
    const sockets: FakeSocket[] = []
    let refreshCalls = 0
    const sock = new RingCentralSocket({
      getToken: () => null,
      refreshToken: async () => {
        refreshCalls++
        return 'freshAT'
      },
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 1_000
    })
    await sock.start()
    sockets[0].open()
    expect(refreshCalls).toBe(1)
    await sock.stop()
  })

  it('throws when no token and no refreshToken is available', async () => {
    const clk = virtualClock()
    const sock = new RingCentralSocket({
      getToken: () => null,
      createSocket: () => new FakeSocket(),
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999
    })
    await expect(sock.start()).rejects.toThrow()
  })

  it('onTyping dispatches typing events', async () => {
    const clk = virtualClock()
    const fake = new FakeSocket()
    const sock = new RingCentralSocket({
      getToken: () => 'AT',
      createSocket: () => fake,
      now: clk.now,
      setTimeout: clk.schedule,
      clearTimeout: () => {},
      pingIntervalMs: 999_999,
      staleAfterMs: 999_999,
      eventFilters: ['/restapi/v1.0/glip/typing']
    })
    const seen = vi.fn()
    sock.onTyping(seen)
    await sock.start()
    fake.open()
    fake.deliver(
      JSON.stringify({
        event: '/restapi/v1.0/glip/typing',
        body: { chatId: 'c1', personId: 'u1', personName: 'Alice' }
      })
    )
    expect(seen).toHaveBeenCalledWith({ chatId: 'c1', personId: 'u1', personName: 'Alice' })
    await sock.stop()
  })
})
