/**
 * RingCentral WebSocket realtime client.
 *
 * Connects to the WebSocket gateway and subscribes to Glip event filters.
 * Handles:
 *   - subscribe/unsubscribe with ack tracking
 *   - keepalive pings (and stale-connection detection)
 *   - automatic reconnect with exponential backoff and a cap
 *   - session recovery (sends sequenceId from the last seen notification)
 *   - dispatching notifications + typing events to listeners
 *
 * The WebSocket implementation and clock are injected so the client can be
 * unit-tested with an in-memory fake socket and fake timers.
 *
 * The connection URL carries the bearer token, per RC's token-authenticated WS:
 *   wss://ws-api.ringcentral.com?token=<access_token>
 *
 * NOTE: The official SDK negotiates a short-lived WS token, but RC also accepts
 * the access token directly for app-level connections. For robustness we refresh
 * the token before reconnecting.
 */

import {
  WS_GATEWAY,
  RingCentralAuthError
} from './ringcentral.js'
import type {
  RealtimeEnvelope,
  RealtimeSubscription,
  RealtimeListener,
  TypingListener,
  TypingPayload
} from '../types.js'

/** Minimal WebSocket-like interface used by the client. */
export interface SocketLike {
  readonly readyState: number
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED */
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED — mirrors the WS spec. */
export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const

export interface WebSocketFactory {
  (url: string): SocketLike
}

export interface RingCentralSocketOptions {
  gateway?: string
  /** Returns the current access token (used for connection + reconnects). */
  getToken: () => string | null
  /** Optional: refresh token before reconnecting (returns new token). */
  refreshToken?: () => Promise<string | null>
  createSocket: WebSocketFactory
  /** Clock + scheduler injected for deterministic tests. */
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => void
  clearTimeout?: (handle: unknown) => void
  /** Event filters to subscribe to once connected. */
  eventFilters?: string[]
  /** Ping interval ms (default 30s). RC requires keepalive. */
  pingIntervalMs?: number
  /** Stale threshold: if no message in this window, force reconnect. */
  staleAfterMs?: number
  /** Base reconnect backoff. */
  reconnectBaseMs?: number
  /** Max reconnect backoff. */
  reconnectMaxMs?: number
  /**
   * Called when the socket reconnects after a drop (NOT on the initial
   * connect). Used to trigger a missed-event reconcile in the renderer.
   */
  onReconnect?: () => void
}

/** Subscribe/Unsubscribe message envelope sent over the socket. */
interface SubscribeMessage {
  message: {
    type?: 'Subscribe' | 'Unsubscribe' | 'Renew' | 'Pong'
    eventFilters: string[]
    deliveryMode?: { transportType: 'WebSocket' }
    sessionRecovery?: { sequenceId?: number }
  }
}

interface SubscriptionAck {
  type: 'SubscriptionConfirmation' | 'SubscriptionUpdate' | 'Error'
  subscriptionId?: string
  status?: number
  message?: string
}

interface Notification extends RealtimeEnvelope {
  sequenceId?: number
}

function isAck(v: unknown): v is SubscriptionAck {
  if (!v || typeof v !== 'object') return false
  const t = (v as Record<string, unknown>).type
  return t === 'SubscriptionConfirmation' || t === 'SubscriptionUpdate' || t === 'Error'
}

function isNotification(v: unknown): v is Notification {
  if (!v || typeof v !== 'object') return false
  return typeof (v as Record<string, unknown>).event === 'string'
}

export class RingCentralSocket implements RealtimeSubscription {
  private socket: SocketLike | null = null
  private listeners = new Set<RealtimeListener>()
  private typingListeners = new Set<TypingListener>()
  private eventFilters: string[]
  private sequenceId = 0
  private lastMessageAt: number
  private pingTimer: unknown = null
  private staleTimer: unknown = null
  private reconnectTimer: unknown = null
  private attempts = 0
  private stopped = true
  /** True after the first successful connect, so we can detect reconnects. */
  private hasConnectedBefore = false
  private pendingAckResolvers: Array<(ack: SubscriptionAck) => void> = []

  private readonly gateway: string
  private readonly getToken: () => string | null
  private readonly refreshToken?: () => Promise<string | null>
  private readonly createSocket: WebSocketFactory
  private readonly now: () => number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => void
  private readonly clearTimeoutFn: (handle: unknown) => void
  private readonly pingIntervalMs: number
  private readonly staleAfterMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly onReconnect?: () => void

  constructor(opts: RingCentralSocketOptions) {
    this.gateway = opts.gateway ?? WS_GATEWAY
    this.getToken = opts.getToken
    this.refreshToken = opts.refreshToken
    this.createSocket = opts.createSocket
    this.now = opts.now ?? Date.now
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as number | undefined))
    this.eventFilters = opts.eventFilters ?? [
      '/restapi/v1.0/glip/posts',
      '/restapi/v1.0/glip/chats'
    ]
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000
    this.staleAfterMs = opts.staleAfterMs ?? 90_000
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000
    this.onReconnect = opts.onReconnect
    this.lastMessageAt = this.now()
  }

  onRealtime(listener: RealtimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onTyping(listener: TypingListener): () => void {
    this.typingListeners.add(listener)
    return () => this.typingListeners.delete(listener)
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.attempts = 0
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    if (this.socket && this.socket.readyState < READY_STATE.CLOSING) {
      try {
        this.socket.close(1000, 'client-stop')
      } catch {
        /* ignore */
      }
    }
    this.socket = null
    // Reset so the next start()'s first connect is treated as initial, not a
    // reconnect.
    this.hasConnectedBefore = false
  }

  isRunning(): boolean {
    return !this.stopped
  }

  /**
   * Force the socket to close and reconnect immediately. Used on system wake
   * (where timers didn't tick during sleep, so the stale watchdog can't fire
   * promptly). No-op if stopped or no socket. The existing onclose → reconnect
   * path handles the actual reconnect; onReconnect fires once it reopens.
   */
  forceReconnect(): void {
    if (this.stopped) return
    const s = this.socket
    if (!s || s.readyState >= READY_STATE.CLOSING) return
    this.clearTimers()
    try {
      s.close(4000, 'forced')
    } catch {
      /* ignore */
    }
  }

  // ── connection lifecycle ─────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return
    let token = this.getToken()
    if (!token) {
      if (this.refreshToken) {
        token = await this.refreshToken()
      }
      if (!token) {
        throw new RingCentralAuthError('No access token for WebSocket connection', null)
      }
    }

    const socket = this.createSocket(`${this.gateway}?token=${encodeURIComponent(token)}`)
    this.socket = socket

    socket.onopen = () => {
      // A reconnect is any successful open after the first one. Fire the
      // callback before re-subscribing so listeners can prepare; the missed-
      // event reconcile it triggers is debounced in main regardless.
      const wasReconnect = this.hasConnectedBefore
      this.hasConnectedBefore = true
      this.attempts = 0
      this.lastMessageAt = this.now()
      this.sendSubscribe().catch(() => {
        /* swallow; errors surface via onerror / onclose */
      })
      this.schedulePing()
      this.scheduleStaleCheck()
      if (wasReconnect) this.onReconnect?.()
    }

    socket.onmessage = (ev) => this.handleMessage(ev.data)

    socket.onclose = () => {
      this.clearTimers()
      if (!this.stopped) this.scheduleReconnect()
    }

    socket.onerror = () => {
      // onclose will follow and trigger reconnect.
    }
  }

  private handleMessage(data: string): void {
    this.lastMessageAt = this.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    if (isAck(parsed)) {
      this.flushAckWaiters(parsed)
      return
    }

    if (isNotification(parsed)) {
      // A pong can arrive as a notification with no sequenceId; treat no-event
      // payloads as keepalives only.
      if (parsed.event === 'Pong' || parsed.event === '/restapi/v1.0/ping') return

      if (typeof parsed.sequenceId === 'number') {
        this.sequenceId = Math.max(this.sequenceId, parsed.sequenceId)
      }

      // Typing events use a dedicated event filter when available.
      if (parsed.event.includes('/glip/typing') || parsed.event.includes('/typing')) {
        const body = parsed.body as Record<string, unknown>
        for (const l of this.typingListeners) {
          l({
            chatId: String(body?.chatId ?? body?.groupId ?? ''),
            personId: String(body?.personId ?? body?.creatorId ?? ''),
            personName: String(body?.personName ?? body?.name ?? 'Someone')
          })
        }
        return
      }

      for (const l of this.listeners) l(parsed)
    }
  }

  // ── subscribe / keepalive ────────────────────────────────────────────────

  private sendSubscribe(): Promise<SubscriptionAck> {
    const msg: SubscribeMessage = {
      message: {
        type: 'Subscribe',
        eventFilters: this.eventFilters,
        deliveryMode: { transportType: 'WebSocket' },
        ...(this.sequenceId > 0
          ? { sessionRecovery: { sequenceId: this.sequenceId } }
          : {})
      }
    }
    this.rawSend(msg)
    return new Promise<SubscriptionAck>((resolve) => {
      this.pendingAckResolvers.push(resolve)
      // Fail-open after a timeout: even without an ack, the server still
      // delivers events to an open socket.
      this.setTimeoutFn(() => {
        const i = this.pendingAckResolvers.indexOf(resolve)
        if (i >= 0) {
          this.pendingAckResolvers.splice(i, 1)
          resolve({ type: 'Error', status: 0, message: 'ack-timeout' })
        }
      }, 10_000)
    })
  }

  private sendPing(): void {
    this.rawSend({ message: { type: 'Pong' } })
  }

  private rawSend(msg: unknown): void {
    const s = this.socket
    if (s && s.readyState === READY_STATE.OPEN) {
      try {
        s.send(JSON.stringify(msg))
      } catch {
        /* ignore transient send failures */
      }
    }
  }

  private flushAckWaiters(ack: SubscriptionAck): void {
    const waiters = this.pendingAckResolvers.splice(0, this.pendingAckResolvers.length)
    for (const r of waiters) r(ack)
  }

  // ── timers ───────────────────────────────────────────────────────────────

  private schedulePing(): void {
    this.clearTimeoutFn(this.pingTimer)
    this.pingTimer = this.setTimeoutFn(() => {
      this.sendPing()
      this.schedulePing()
    }, this.pingIntervalMs)
  }

  private scheduleStaleCheck(): void {
    this.clearTimeoutFn(this.staleTimer)
    this.staleTimer = this.setTimeoutFn(() => {
      const since = this.now() - this.lastMessageAt
      if (since >= this.staleAfterMs && this.socket) {
        // Force reconnect for freshness.
        try {
          this.socket.close(4000, 'stale')
        } catch {
          /* ignore */
        }
        return
      }
      this.scheduleStaleCheck()
    }, this.pingIntervalMs)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.clearTimeoutFn(this.reconnectTimer)
    const backoff = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.attempts
    )
    this.attempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      void this.connect()
    }, backoff)
  }

  private clearTimers(): void {
    this.clearTimeoutFn(this.pingTimer)
    this.clearTimeoutFn(this.staleTimer)
    this.clearTimeoutFn(this.reconnectTimer)
    this.pingTimer = null
    this.staleTimer = null
    this.reconnectTimer = null
  }

  // exposed for tests
  get currentSequenceId(): number {
    return this.sequenceId
  }

  setEventFilters(filters: string[]): void {
    this.eventFilters = filters
    // re-subscribe immediately if connected
    if (this.socket?.readyState === READY_STATE.OPEN) {
      this.rawSend({
        message: { type: 'Subscribe', eventFilters: this.eventFilters }
      })
    }
  }
}

export type { TypingPayload }
