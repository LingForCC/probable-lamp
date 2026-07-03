# Feature: Authentication & Sessions

Sign users in with RingCentral using OAuth 2.0 Authorization Code + PKCE, keep
their session alive across restarts, and let them sign out.

## Actors

- **End user** — the person logging in.
- **RingCentral authorize endpoint** — `/restapi/oauth/authorize` (opened in a `BrowserWindow`).
- **RingCentral token endpoint** — `/restapi/oauth/token` (code exchange, refresh, revoke).

## Modes

The feature behaves differently depending on `RC_API_MODE` (resolved in
`src/main/config.ts`):

| Mode | Login behavior |
| --- | --- |
| `mock` (default) | No network. `AuthController.login` installs a fake `TokenSet` (`MockMessagingClient.login`) and resolves immediately. |
| `real` | Full PKCE flow: open authorize URL → capture `code` on the redirect → exchange for tokens. |

If `RC_API_MODE=real` but no `RC_CLIENT_ID` is set, the app falls back to MOCK
mode and logs a warning (`src/main/index.ts`).

## Workflow (real mode)

```
[LoginScreen: "Sign in"] ──► store.doLogin ──IPC auth:login──► IpcController
   └─► AuthController.login(opener)
         1. state = random 16-byte hex; verifier = createCodeVerifier()        (auth.ts)
         2. client.buildAuthorizeUrl(state, verifier) → S256 challenge          (pkce.ts)
         3. openAuthWindow(url): BrowserWindow, intercept redirect_uri          (auth.ts)
         4. parseRedirect(finalUrl) → { code, state }
         5. client.exchangeCodeForToken(code, verifier) → TokenSet              (ringcentral.ts)
         6. store.saveTokens (encrypt with safeStorage) + client.setTokens
         7. client.getMe(); realtime.start(); broadcast auth:loggedIn
```

The opener (`openAuthWindow`) intercepts the redirect via `will-redirect` /
`will-navigate` to the configured `RC_REDIRECT_URI`, captures the URL, and closes
the window. If the user closes the window without completing login, the promise
rejects with `"Authentication window closed"`.

## Business rules & edge cases

- **PKCE, not a client secret in the browser.** The verifier (43–128 chars) is the
  secret; the challenge is `BASE64URL(SHA256(verifier))`. `client_secret` is sent
  only on the confidential token exchange when configured.
- **State binding.** A random `state` is sent with the authorize request to bind the
  round-trip (currently not re-validated post-redirect; the redirect is captured
  from a single controlled window).
- **Proactive refresh.** The REST client treats the access token as expired 60s
  before its real expiry (`refreshMarginMs = 60_000`, `isAccessTokenExpired` in
  `ringcentral.ts`). Any REST call refreshes first if needed.
- **Reactive refresh.** A `401` from a REST call triggers refresh + a single retry
  (`restInternal` with a `did401` guard against loops).
- **Refresh survives crashes.** `refreshTokens`, `exchangeCodeForToken`, `revokeToken`,
  and explicit `setTokens` all fire an `onTokensChanged` hook. In main, that hook
  re-persists tokens to the encrypted store (`src/main/index.ts`), so a refresh
  followed by a crash no longer reverts to a stale token.
- **Encrypted at rest.** Tokens are `safeStorage.encryptString`→base64 before being
  written to `electron-store` (`src/main/store.ts`). A plaintext fallback is used
  **only** when the OS keychain is unavailable.
- **Startup restore.** On boot, `store.loadTokens()` rehydrates the client in non-mock
  mode; if the store is corrupt, `loadTokens` returns `null` (non-fatal).

## Logout

`IPC.LOGOUT` → `realtime.stop()`, then (real mode) `client.revokeToken()` →
`store.clearTokens()` → `client.setTokens(null)` → broadcast `auth:loggedOut`.
The renderer resets all session state (`me`, `chats`, `messages`, `people`, `typing`).

## Implementation references

- `src/main/auth.ts` — `AuthController`, `openAuthWindow`, `parseRedirect`, `createState`.
- `src/shared/client/ringcentral.ts` — `exchangeCodeForToken`, `refreshTokens`,
  `revokeToken`, `isAccessTokenExpired`, `executeAuth`.
- `src/shared/client/pkce.ts` — `createCodeVerifier`, `createCodeChallenge`.
- `src/main/store.ts` — `saveTokens`/`loadTokens`/`clearTokens` (safeStorage).
- `src/main/index.ts` — `onTokensChanged` wiring + startup restore.
- `src/renderer/components/LoginScreen.tsx`, `src/renderer/store/appStore.ts` (`doLogin`/`doLogout`).
