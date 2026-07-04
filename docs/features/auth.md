# Feature: Authentication & Sessions

Authenticate to RingCentral using a long-lived JWT (server auth), exchange it
for an access token at startup, keep the session alive across restarts, and let
the user sign out.

## Actors

- **End user** — the person using the app.
- **RingCentral token endpoint** — `/restapi/oauth/token` (jwt-bearer grant
  exchange).
- **OS keychain** — `safeStorage` encrypts the access token before it is written
  to disk.

## Auth model

The app uses RingCentral **JWT (server) auth**. A long-lived JWT is supplied via
the `RC_JWT` environment variable. At startup the JWT is exchanged once for an
access token using the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant; the
returned access token is then used as the `Bearer` credential for all REST
calls and as the `?token=` query parameter for the WebSocket gateway.

There is **no refresh flow** and **no token revocation** on logout — the
access token is treated as non-expiring for this app's purposes, and the JWT is
the long-term credential (re-exchanged on each launch).

## Modes

The feature behaves differently depending on `RC_API_MODE` (resolved in
`src/main/config.ts`):

| Mode | Login behavior |
| --- | --- |
| `mock` (default) | No network. `AuthController.login` installs a fake `TokenSet` (`MockMessagingClient.login`) and resolves immediately. Triggered by the "Enter demo" button. |
| `real` | Auto-connect at boot: exchange `RC_JWT` → access token → load user → start realtime. No login button. |

If `RC_API_MODE=real` but no `RC_JWT` is set, the app falls back to MOCK mode
and logs a warning (`src/main/index.ts`).

## Workflow (real mode)

```
[app boot] ──► IpcController.performLogin()
                 1. AuthController.login()                                   (auth.ts)
                 2. client.exchangeJwtForToken(RC_JWT) → TokenSet            (ringcentral.ts)
                    POST /restapi/oauth/token
                    grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
                    assertion=<RC_JWT>
                 3. store.saveTokens (encrypt with safeStorage) + client.setTokens
                 4. client.getMe(); realtime.start(); broadcast auth:loggedIn
```

On failure (e.g. invalid/expired JWT), main broadcasts `auth:error` and the
renderer shows the `LoginScreen` with a **Retry connection** button.

The renderer learns the boot-time result via the `onAuthStateChanged` push
subscription (`src/renderer/main.tsx` → `applyAuthState`), since the JWT
exchange is in-flight when the window first loads.

## Business rules & edge cases

- **JWT is the credential.** `RC_JWT` is read in `src/main/config.ts` and
  threaded through `createClients` → `RingCentralClient`. The JWT itself is
  never persisted to disk and never exposed to the renderer (the `GET_CONFIG`
  handler omits it).
- **No refresh.** JWTs are not refreshable. The REST client does not proactively
  refresh or retry-on-401; a `401` surfaces as `RingCentralAuthError`. To
  recover, restart the app (which re-exchanges the JWT) or fix `RC_JWT`.
- **Exchange survives crashes.** `exchangeJwtForToken` and explicit `setTokens`
  fire an `onTokensChanged` hook. In main, that hook re-persists the minted
  token set to the encrypted store (`src/main/index.ts`), so a crash after
  exchange keeps the token.
- **Encrypted at rest.** The token set is `safeStorage.encryptString`→base64
  before being written to `electron-store` (`src/main/store.ts`). A plaintext
  fallback is used **only** when the OS keychain is unavailable.
- **Startup restore.** On boot, `store.loadTokens()` rehydrates the client in
  non-mock mode; the auto-login then re-exchanges the JWT regardless, so a stale
  stored token is overwritten. If the store is corrupt, `loadTokens` returns
  `null` (non-fatal).
- **WebSocket.** The socket reads the access token from
  `client.getTokens()?.access_token` and passes it as `?token=`. Under JWT the
  token is always present after boot exchange, so the socket's `refreshToken`
  fallback is effectively unused.

## Logout

`IPC.LOGOUT` → `realtime.stop()` → `store.clearTokens()` → `client.setTokens(null)`
→ broadcast `auth:loggedOut`. There is no server-side revoke (JWTs can't be
revoked client-side). The renderer resets all session state (`me`, `chats`,
`messages`, `people`, `typing`).

## Implementation references

- `src/main/auth.ts` — `AuthController.login` (mock + JWT branches).
- `src/main/config.ts` — `loadConfig()` reads `RC_JWT`.
- `src/shared/client/ringcentral.ts` — `exchangeJwtForToken`, `executeAuth`,
  bearer-auth header in `rest`/`uploadFile`.
- `src/main/store.ts` — `saveTokens`/`loadTokens`/`clearTokens` (safeStorage).
- `src/main/index.ts` — auto-connect at boot, `onTokensChanged` wiring, startup
  restore.
- `src/main/ipc.ts` — `performLogin`, `IPC.LOGIN`/`LOGOUT` handlers,
  `pushAuthState`.
- `src/renderer/store/appStore.ts` — `doLogin`/`doLogout`, `applyAuthState`.
- `src/renderer/components/LoginScreen.tsx` — retry button (real mode), "Enter
  demo" (mock mode).
