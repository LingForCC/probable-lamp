# Architecture

A concise overview of how RC Messenger is structured and how data flows through it.
For per-feature business logic, see [`docs/features/`](docs/features/).

## TL;DR

RC Messenger is an **Electron** app (main + preload + renderer) written in
**TypeScript** (strict), with a **React + Tailwind** UI built by **Vite**, and a
**custom RingCentral REST + WebSocket client** (no SDK). A **MOCK mode** swaps the
real client for an in-memory fake so the whole app and its tests run with zero
credentials and no network.

```
┌──────────────────────────── Electron ────────────────────────────┐
│                                                                   │
│  Renderer (React + zustand)            Preload (contextBridge)    │
│  ┌─────────────────────────┐           ┌──────────────────┐       │
│  │ App / Components        │◄──────────►│ window.rcm API   │  IPC  │
│  │ store/appStore.ts       │  typed     │ (no Node exposed)│       │
│  └────────────▲────────────┘  bridge    └────────▲─────────┘       │
│               │ applyRealtime/applyTyping        │ invoke/on       │
│               │                                 │                 │
│  ═════════════╪═════════════════════════════════╪═══════════════  │
│               │                                 │                 │
│  Main process │                                 │                 │
│  ┌────────────┴─────────────────┐  ┌────────────┴──────────┐      │
│  │ IpcController                │  │ AuthController (PKCE)  │      │
│  │  • forwards realtime/typing  │  │ AppStore (safeStorage) │      │
│  │  • fires notifications       │  │ createMainWindow       │      │
│  └────────────▲─────────────────┘  └────────────────────────┘      │
│               │                                                   │
│               │ delegates to                                      │
│  ┌────────────┴───────────────────────────────────────────────┐   │
│  │ shared/client/                                             │   │
│  │  index.ts ──► RingCentralClient (REST) ──► RingCentral API  │   │
│  │          └──► RingCentralSocket (WS)   ──► wss://…/posts    │   │
│  │          └──► MockMessagingClient (in-memory fake)         │   │
│  │  + pkce.ts · rateLimiter.ts                                │   │
│  └────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

## Three Electron layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| **Main** | `src/main/` | App lifecycle, window, OAuth, IPC handlers, notifications, encrypted token store. Node APIs live here. |
| **Preload** | `src/preload/` | A typed `window.rcm` bridge via `contextBridge`. Strict allow-list of IPC invokers + push subscribers. **No Node is exposed to the renderer.** |
| **Renderer** | `src/renderer/` | React UI + `zustand` store. Talks to the world only through `window.rcm`. |

## Shared modules (`src/shared/`)

Pure, environment-agnostic code imported by both main and renderer:

- **`types.ts`** — the Glip data model (`GlipPost`, `GlipChat`, `GlipPerson`, …),
  the `IPC` channel-name constants (single source of truth for the contract), and
  the `IMessagingClient` / `RealtimeSubscription` interfaces.
- **`rcmApi.ts`** — the `RcmApi` type (shape of `window.rcm`), defined here so the
  renderer/tests can import it **without** pulling in the preload (which imports `electron`).
- **`client/`** — the client layer (below).

## Client layer (`src/shared/client/`)

A single `IMessagingClient` interface implemented by two interchangeable backends,
selected by `RC_API_MODE`:

```
createClients(opts) ──► mock   ? MockMessagingClient  (in-memory; doubles as realtime)
                  └──► real  ? RingCentralClient (REST) + RingCentralSocket (WS)
```

- **`ringcentral.ts`** — REST: OAuth Authorization Code + PKCE, proactive refresh
  (60s margin), 401→refresh→retry-once, 429 backoff, all Glip endpoints. All IO
  (`fetch`, `sha256`, clock) is injected for testability. An `onTokensChanged`
  hook lets main re-persist tokens after a REST-driven refresh.
- **`websocket.ts`** — `wss://ws-api.ringcentral.com` subscribe/keepalive, with
  **session recovery** (replays from the last `sequenceId`) and exponential-backoff
  reconnect.
- **`rateLimiter.ts`** — token-bucket limiter per RingCentral rate group (Auth 5/min,
  Medium 40/min, Light 50/min) with an injected clock/scheduler for deterministic tests.
- **`pkce.ts`** — RFC 7636 PKCE helpers (verifier/challenge), with an injected hash.
- **`mock/mockClient.ts`** — fake backend with seeded data and a simulated realtime
  auto-reply; identical interface to the real client.

> **Why no SDK?** You asked for a custom client. The injected `fetch`/`sha256`/clock
> design keeps the whole client unit-testable without Electron or network.

## Data flow: send a message + receive a realtime reply

```
[Composer] ─Enter─► store.sendText
   1. insert OPTIMISTIC post (pending=true, localId)
   2. window.rcm.sendPost ─IPC─► IpcController ─► client.sendPost ─POST /glip/chats/{id}/posts
   3. on 200: replace localId → server post (pending=false)

   meanwhile, the server pushes a PostAdded event:
[WS gateway] ─► RingCentralSocket.handleMessage
   ─► listeners ─► IpcController.startRealtimeForwarding
        ├─ broadcast(IPC.REALTIME_EVENT, env) ─► preload ─► window.rcm.onRealtimeEvent
        │       └─► store.applyRealtime (dedup by id, append, bump unread if not active)
        └─ maybeNotify → desktop Notification (only if PostAdded, not own, window not focused, not seen)
```

## Key design decisions

1. **Strict IPC contract.** Channel names live in `shared/types.ts`. The preload and
   main reference the same constants — no stringly-typed channels, no typos.
2. **Injectable IO everywhere.** `fetch`, `sha256`, the clock, the scheduler, and the
   WebSocket factory are all constructor parameters. This is why the client, the rate
   limiter, the WebSocket client, and the store are all unit-tested with fakes and no
   real timers.
3. **Optimistic UI.** `sendText`/`edit`/`delete` mutate the store immediately and
   reconcile on the server response. Realtime `PostAdded` events are deduped against
   existing post ids so the server echo of your own message doesn't double up.
4. **Security by construction.** `contextIsolation: true`, `nodeIntegration: false`,
   no preload Node exposure; tokens encrypted at rest with `safeStorage`; a strict CSP
   on the renderer; external links open in the system browser; Markdown output is
   sanitized before rendering.
5. **MOCK-first.** The app boots into MOCK mode with no `.env`, so it's demoable and
   fully testable offline. Real mode activates only when `RC_API_MODE=real` **and**
   `RC_CLIENT_ID` are set.

## Testing strategy

- **Unit (Vitest, 102 tests)** — `pkce` (incl. the RFC 7636 S256 vector), `rateLimiter`,
  the REST client (auth/refresh/pagination/429/proactive-refresh/endpoints), the WS
  client (subscribe/dispatch/sequenceId/reconnect/session-recovery), the mock client,
  `notifications`, the renderer `appStore`, the `MessageItem` component, and utils.
- **E2E (Playwright, 3 tests)** — builds the app then drives the **packaged Electron
  binary** in MOCK mode through the full flow (login → chats → send → realtime reply →
  edit → delete → theme → logout), plus team creation and search.

See [`README.md`](README.md) for commands, and [`docs/features/`](docs/features/) for
business-logic detail per feature.
