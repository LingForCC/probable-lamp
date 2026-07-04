# Feature: Realtime Updates

Push new/edited/deleted messages to the UI the instant they happen, over a
persistent WebSocket connection to RingCentral, with automatic recovery.

## Actors

- **RingCentral WebSocket gateway** — `wss://ws-api.ringcentral.com`.
- **The current user** — receives updates for chats they're in.

## Connection lifecycle

```
after login: IpcController ─► realtime.start()
   RingCentralSocket.connect()
      1. token = getToken()  (the JWT-derived access token; see auth.md)
      2. open WebSocket: wss://ws-api.ringcentral.com?token=<access_token>
      3. onopen → send Subscribe { eventFilters, deliveryMode: WebSocket }
      4. start keepalive (ping every 30s) + stale check
```

- **Event filters**: `/restapi/v1.0/team-messaging/posts` and `/restapi/v1.0/team-messaging/chats` by default.
- **Keepalive**: a `Pong` message every `pingIntervalMs` (30s); a stale check force
  -reconnects if nothing arrives within `staleAfterMs` (90s).

## Reconnect & session recovery

On `onclose` (and not stopped), the socket schedules a reconnect with **exponential
backoff**: `min(reconnectMaxMs, reconnectBaseMs * 2^attempts)` (base 1s, max 30s).
`attempts` resets to 0 after a successful `onopen`.

**Session recovery**: every inbound notification carries a `sequenceId`. The socket
tracks the highest seen. On the next Subscribe (after reconnect) it includes
`sessionRecovery: { sequenceId }`, asking the server to replay any events missed
during the disconnect — so a brief drop doesn't lose messages.

### Reconnect signaling & unread re-reconcile

RC's replay buffer is finite, so for a long disconnect (machine asleep, extended
network loss) recovery can be silently exhausted and events stay missing. Two
hooks close that gap by re-triggering the renderer's watermark-based unread
reconcile (see [conversations.md](conversations.md) § "Unread (local)"):

- **`onReconnect`** — an optional callback on `RingCentralSocketOptions`, fired in
  `socket.onopen` only when the open is a *reconnect* (not the initial connect,
  tracked via an internal `hasConnectedBefore` flag). Covers network drops and
  post-wake reconnects.
- **`forceReconnect()`** — a public method that closes the current socket with
  code `4000 'forced'`, letting the existing `onclose → backoff → onopen` path
  reconnect. Called on `powerMonitor`'s `resume` event because the keepalive
  timer doesn't tick during sleep, so the stale watchdog can't fire promptly.

Main wires both into `IpcController.notifyRealtimeReconnected()`, which debounces
5s (a wake that also causes a WS reconnect fires one reconcile, not two) and
broadcasts `IPC.REALTIME_RECONCILED`. The renderer's `main.tsx` subscribes to it
and calls `store.reconcileUnread` → `refreshChats` + `reconcileUnreadForAll`. The
recount is idempotent and only fetches chats with activity newer than the
watermark, so it's safe to fire speculatively. Only wired in real mode
(`!isMock`); the mock never reconnects.

## Handling an inbound envelope

```
WS onmessage ─► RingCentralSocket.handleMessage                       (websocket.ts)
   1. update lastMessageAt (feeds stale check)
   2. JSON.parse (ignore unparseable)
   3. ack (SubscriptionConfirmation/Update/Error) → resolve pending acks; return
   4. Pong / ping keepalive → return
   5. typing event (/team-messaging/typing) → dispatch to typingListeners; return
   6. else → dispatch to realtimeListeners
```

Realtime listeners are wired in `IpcController.startRealtimeForwarding`
(`src/main/ipc.ts`), which for each envelope:

1. **broadcasts** it to every window via `push:realtime-event` → preload →
   `window.rcm.onRealtimeEvent` → `store.applyRealtime`.
2. calls `maybeNotify` (see [notifications.md](notifications.md)).

## applyRealtime rules (renderer store)

`applyRealtime(envelope)` in `appStore.ts` switches on `body.eventType`:

| Event | If chat is loaded | If chat is NOT loaded |
| --- | --- | --- |
| **PostAdded** | **Dedup** by `post.id` (skip if already present); else append, enrich `isOwn`, bump chat preview/time, and update the `unread` map: `+1` for inactive chats, `0` for the active chat (own messages never count). The active chat's `lastReadTime` watermark also advances to the post and is persisted. | Don't insert the post; just update the chat row's preview/time and the `unread` map (`+1`, or `0` if active). |
| **PostUpdated** | Replace the post in place with the new body. | No-op. |
| **PostRemoved** | Remove the post by id. | No-op. |

**Dedup** also runs on every append (keyed on `localId ?? id`), so the server echo of
your own optimistic send, a session-recovery replay, and a normal push never produce
duplicates.

## Edge cases

- **Self-messages** arrive as realtime events too; they're marked `isOwn` via
  `enrichOwn` and never trigger a desktop notification (see notifications gating).
- **Reconnect storm**: backoff caps at 30s; `attempts` resets on each successful open.
- **No token**: under JWT auth the access token is always present after the boot
  exchange, so `getToken()` is not null. If it ever is (e.g. exchange failed),
  `connect` throws `RingCentralAuthError`. There is no refresh fallback.

## MOCK-mode specifics

`MockMessagingClient` *is* its own `RealtimeSubscription` — there's no socket. After
a `sendPost`, and only while `running`, it schedules a single `PostAdded` reply after
`autoReplyMs` (default 1500ms), authored by the most recent non-`me` participant in
that chat, from a canned reply list. Unread tracking is a renderer concern (see
[conversations.md](conversations.md) § "Unread (local)"); the mock no longer bumps or
tracks unread at all. Tests can drive deterministic replies via the injected `schedule`.

## Implementation references

- `src/shared/client/websocket.ts` — `RingCentralSocket` (connect, handleMessage,
  subscribe, ping, reconnect, session recovery, typing routing).
- `src/main/ipc.ts` — `startRealtimeForwarding`, `broadcast`.
- `src/preload/index.ts` — `onRealtimeEvent` subscriber.
- `src/renderer/main.tsx` — subscribes `applyRealtime`.
- `src/renderer/store/appStore.ts` — `applyRealtime` (+ dedupe helpers).
- `src/shared/client/mock/mockClient.ts` — simulated auto-reply.
