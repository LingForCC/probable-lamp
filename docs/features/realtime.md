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
      1. token = getToken()  (refresh if null + refreshToken provided)
      2. open WebSocket: wss://ws-api.ringcentral.com?token=<access_token>
      3. onopen → send Subscribe { eventFilters, deliveryMode: WebSocket }
      4. start keepalive (ping every 30s) + stale check
```

- **Event filters**: `/restapi/v1.0/glip/posts` and `/glip/chats` by default.
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

## Handling an inbound envelope

```
WS onmessage ─► RingCentralSocket.handleMessage                       (websocket.ts)
   1. update lastMessageAt (feeds stale check)
   2. JSON.parse (ignore unparseable)
   3. ack (SubscriptionConfirmation/Update/Error) → resolve pending acks; return
   4. Pong / ping keepalive → return
   5. typing event (/glip/typing) → dispatch to typingListeners; return
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
| **PostAdded** | **Dedup** by `post.id` (skip if already present); else append, enrich `isOwn`, bump chat preview/time, and bump unread (`+1` unless it's the active chat → `0`). | Don't insert the post; just update the chat row's preview/time/unread (`+1`, or `0` if active). |
| **PostUpdated** | Replace the post in place with the new body. | No-op. |
| **PostRemoved** | Remove the post by id. | No-op. |

**Dedup** also runs on every append (keyed on `localId ?? id`), so the server echo of
your own optimistic send, a session-recovery replay, and a normal push never produce
duplicates.

## Edge cases

- **Self-messages** arrive as realtime events too; they're marked `isOwn` via
  `enrichOwn` and never trigger a desktop notification (see notifications gating).
- **Reconnect storm**: backoff caps at 30s; `attempts` resets on each successful open.
- **No token**: if `getToken()` returns null and there's no `refreshToken`, `connect`
  throws `RingCentralAuthError`.

## MOCK-mode specifics

`MockMessagingClient` *is* its own `RealtimeSubscription` — there's no socket. After
a `sendPost`, and only while `running`, it schedules a single `PostAdded` reply after
`autoReplyMs` (default 1500ms), authored by the most recent non-`me` participant in
that chat, from a canned reply list. It deliberately does **not** bump unread for the
reply. Tests can drive deterministic replies via the injected `schedule`.

## Implementation references

- `src/shared/client/websocket.ts` — `RingCentralSocket` (connect, handleMessage,
  subscribe, ping, reconnect, session recovery, typing routing).
- `src/main/ipc.ts` — `startRealtimeForwarding`, `broadcast`.
- `src/preload/index.ts` — `onRealtimeEvent` subscriber.
- `src/renderer/main.tsx` — subscribes `applyRealtime`.
- `src/renderer/store/appStore.ts` — `applyRealtime` (+ dedupe helpers).
- `src/shared/client/mock/mockClient.ts` — simulated auto-reply.
