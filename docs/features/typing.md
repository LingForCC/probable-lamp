# Feature: Typing Indicators

Show "X is typing…" in the chat header so users know a teammate is composing a reply.

## Actors

- **Typer** — any member (other than you) composing a message in a chat you have open.
- **Viewer** — you, seeing the indicator.

> **Note on MOCK vs real mode:** In MOCK mode the indicator is driven entirely
> client-side by the mock backend's `emitTyping`. Against the real RingCentral API,
> typing is a **one-way** signal you send to the server; the inbound event you'd
> render here comes through the same WebSocket subscription as messages (event filter
> `/team-messaging/typing`).

## Outbound: when you type

```
[Composer onChange]
   1. update text, auto-grow textarea
   2. if now - lastTyping.current > 3000ms (3s throttle) AND activeChatId set:
        lastTyping.current = now
        store.setTyping(api, activeChatId)
           └─IPC set:typing──► client.setTyping(chatId) ─POST /team-messaging/v1/chats/{id}/typing
```

- **Throttled to once per 3 seconds** per typing session (`lastTyping` ref) to avoid
  spamming the server.
- `setTyping` in the store swallows errors — typing notifications are best-effort and
  must never block sending.

## Inbound: displaying who is typing

An inbound typing event flows: WS → `RingCentralSocket.handleMessage` → typed
listeners → `IpcController` broadcasts `push:typing-event` → preload →
`window.rcm.onTypingEvent` → `store.applyTyping`.

```
store.applyTyping({ chatId, personId, personName })                  (appStore.ts)
   1. remove any existing entry for personId in typing[chatId]
   2. append the new payload
   3. schedule setTimeout(…, 4000): remove that personId again
```

`ChatView` renders the indicator below the message list:

| Typers | Text |
| --- | --- |
| 0 | (nothing) |
| 1 | `Alice is typing…` |
| 2+ | `3 people are typing…` |

## Business rules & edge cases

- **Auto-clear after 4s** per typer. If the same person keeps typing, their entry is
  refreshed (removed + re-added) and a new 4s timer is scheduled.
- **Per-chat scoping**: typing state is a `Record<chatId, TypingPayload[]>`; switching
  chats shows only the relevant typers.
- **No self-indicator**: the UI only renders *inbound* typing from others; your own
  outbound signal goes to the server and to other clients.
- In MOCK mode there is no real socket; `MockMessagingClient.emitTyping` dispatches
  directly to typing listeners (used by unit tests).

## Implementation references

- `src/renderer/components/Composer.tsx` — 3s throttle, `setTyping` call.
- `src/renderer/store/appStore.ts` — `setTyping` (outbound) + `applyTyping` (inbound,
  4s auto-clear).
- `src/renderer/components/ChatView.tsx` — indicator rendering.
- `src/shared/client/websocket.ts` — typing event routing (`/team-messaging/typing`).
- `src/main/ipc.ts` — `onTyping` → broadcast `push:typing-event`.
- `src/shared/client/mock/mockClient.ts` — `emitTyping` (test helper).
