# RC Messenger

A desktop IM app (Slack-like) for **RingCentral Team Messaging** (Glip), built with
**Electron + React + TypeScript + Vite + Tailwind CSS**. It ships with a full
**MOCK mode** so you can run and test the entire app with **zero credentials and no
network**, then drop in real RingCentral OAuth credentials to use it against the
live API.

---

## Features

- **OAuth Authorization Code + PKCE** login in a secure `BrowserWindow`; access &
  refresh tokens persisted with Electron `safeStorage` (encrypted at rest).
- **Proactive token refresh** before expiry, plus a `401 → refresh → retry` path.
- **Conversation sidebar**: teams, groups, direct messages; unread badges,
  search/filter, avatars, relative timestamps.
- **Message list**: paginated history (`recordCount`/`pageToken`), infinite
  scroll-up to load older messages, Markdown rendering, RingCentral mention
  syntax (`![:Name](personId)`), message grouping, optimistic send with
  reconcile, edit/delete.
- **Composer**: Markdown + mentions, Enter to send / Shift+Enter for newline,
  typing indicators (throttled).
- **Realtime** via the RingCentral WebSocket gateway (`wss://ws-api.ringcentral.com`)
  with keepalive pings, **session recovery** (replays from last `sequenceId`),
  and exponential-backoff reconnect. New messages update the UI live and fire
  desktop notifications.
- **Teams**: list and create teams.
- **Attachments**: file upload via `POST /glip/files` (rendered as chips/cards).
- **Search** across messages.
- **Settings**: light/dark/system theme, sandbox/production server, MOCK toggle,
  log out (revokes the token).
- **Client-side rate limiting** (token bucket) honoring RingCentral's buckets
  (Auth 5/min, Medium 40/min, …) with a server-driven `429` retry backstop.

---

## Quick start

```bash
npm install
npm run dev        # launches the Electron app in dev (MOCK mode by default)
```

By default the app runs in **MOCK mode** (no RingCentral account needed). On the
login screen click **"Enter demo"** to explore seeded chats, messages, simulated
realtime replies, edit/delete, theme switching, etc.

### Use the real RingCentral API

1. Register a **REST API App** at <https://developer.ringcentral.com>.
2. Under **Settings → OAuth Redirect URIs**, add your redirect URI
   (default: `http://localhost:4173/auth/callback`).
3. Enable scopes: **Team Messaging**, **WebSocket Subscriptions**, **Read Accounts**.
4. Copy `.env.example` to `.env` and fill in:

   ```ini
   RC_CLIENT_ID=your_app_key
   RC_CLIENT_SECRET=your_app_secret        # optional for pure-PKCE public clients
   RC_REDIRECT_URI=http://localhost:4173/auth/callback
   RC_SERVER=sandbox                       # or production
   RC_API_MODE=real
   ```

5. `npm run dev` and sign in with RingCentral.

> With no `RC_CLIENT_ID` set, the app automatically falls back to MOCK mode.

---

## Architecture

```
src/
  main/          Electron main process
    index.ts        app bootstrap; wires clients, IPC, realtime, window
    window.ts       BrowserWindow factory
    ipc.ts          IPC controller (renderer ⇄ main ⇄ client)
    store.ts        electron-store + safeStorage (encrypted tokens, settings)
    auth.ts         OAuth Authorization Code + PKCE flow
    notifications.ts desktop notifications for incoming messages
    config.ts       env-based config resolution
    nodeCrypto.ts   Node SHA-256 + base64 for PKCE
  preload/       contextBridge exposing a typed `window.rcm` API (no Node exposed)
  renderer/      React + Tailwind UI
    store/appStore.ts   zustand state (auth, chats, messages, realtime, theme)
    components/         Sidebar, ChatView, MessageList, MessageItem, Composer,
                        LoginScreen, SettingsModal, CreateTeamModal, …
    lib/                api accessor + markdown/time utils
  shared/
    types.ts        Glip data model, IPC channel contract, client interface
    rcmApi.ts       typed shape of the preload bridge
    client/
      pkce.ts         RFC 7636 PKCE helpers (injectable hash/encoder)
      rateLimiter.ts  token-bucket limiter per RC rate group
      ringcentral.ts  custom REST client (auth, refresh, 429 retry, all Glip endpoints)
      websocket.ts    WS client (subscribe, keepalive, reconnect, session recovery)
      mock/           in-memory mock backend (same interface, simulated realtime)
      index.ts        factory: returns Mock or Real client + realtime source
tests/
  unit/   vitest + jsdom (pkce, rate limiter, REST client, WS, mock, store, components, utils, notifications)
  e2e/     Playwright driving the packaged Electron app in MOCK mode
```

### Design notes

- **No RingCentral SDK.** A custom REST client (`ringcentral.ts`) and WebSocket
  client (`websocket.ts`) implement auth, refresh, rate limiting, 429 retry,
  keepalive, reconnect, and session recovery directly. All IO (fetch, sha256,
  clock, scheduler) is dependency-injected so everything is unit-testable with
  fakes.
- **Strict IPC contract.** Channel names live in `shared/types.ts` (`IPC`) and are
  shared by the preload bridge and main handlers, preventing typos.
- **Test isolation.** The mock client and a fake `window.rcm` API let the store
  and components be tested without Electron. E2E tests run the real packaged app
  in MOCK mode.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Launch the app in dev (HMR via electron-vite). |
| `npm run build` | Build main + preload + renderer to `out/`. |
| `npm run preview` | Preview the built app. |
| `npm run typecheck` | Strict `tsc --noEmit` across all three tsconfig projects. |
| `npm run lint` | ESLint over the codebase. |
| `npm test` | Run the unit test suite (Vitest). |
| `npm run test:watch` | Unit tests in watch mode. |
| `npm run test:e2e` | Build then run Playwright E2E tests in MOCK mode. |
| `npm run package` | Build a distributable with electron-builder. |

---

## Testing

- **Unit (101 tests):** PKCE (incl. the RFC 7636 S256 test vector), rate limiter
  (refill/backoff/capacity), the REST client (auth/refresh/pagination/429/proactive
  refresh/all endpoints), the WebSocket client (subscribe/dispatch/sequenceId/
  reconnect/session recovery), the mock client, the notifications logic, the
  renderer store (login/select/send/edit/delete/realtime/dedup/typing/theme), the
  message component, and the markdown/time utils.
- **E2E (3 tests):** drive the packaged Electron app in MOCK mode through the
  full flow — login → browse chats → open a chat → send → receive a simulated
  realtime reply → edit → delete → theme toggle → logout — plus creating a team
  and search/filter.

Run everything:

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
```

---

## Security

- Tokens are encrypted with Electron `safeStorage` (OS keychain) before being
  written to disk. A plaintext fallback is used only when the platform keychain
  is unavailable (logged at startup).
- The renderer has **no Node access** (`contextIsolation: true`,
  `nodeIntegration: false`); it can only call the allow-listed `window.rcm` API.
- External links open in the system browser, never in-app.
- A strict Content-Security-Policy is set on the renderer; Markdown output is
  sanitized before rendering.
