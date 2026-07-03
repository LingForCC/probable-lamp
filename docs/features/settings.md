# Feature: Settings & Theming

Let the user switch the visual theme, inspect the connection, and sign out.

## Actors

- **The user** — personalizes the app and manages their session.

## Settings modal (`SettingsModal.tsx`)

Opened from the sidebar's gear button. Contains:

### Theme

Three options — **light**, **dark**, **system** — applied immediately:

```
click theme option ─► store.setTheme(api, theme)                     (appStore.ts)
   1. window.rcm.updateSettings({ theme })
      ─IPC app:update-settings──► store.updateSettings (electron-store, plaintext)
   2. update config.theme in the store (instant re-render)
```

`App.tsx` applies the theme to `<html>`:
- `dark` → add `dark` class
- `light` → remove `dark` class
- `system` → follow `prefers-color-scheme`, with a live listener that updates when
  the OS theme changes.

### Connection (read-only)

Displays the current `apiMode` (`mock` / `real`) and `server` (`sandbox` /
`production`) so the user knows which backend they're connected to.

### Log out

Triggers `store.doLogout` (see [auth.md](auth.md)).

## Business rules

- Theme is the only **persisted, user-editable** setting; it's stored in plaintext in
  `electron-store` (`AppStore.settings.theme`), so it survives restarts.
- `system` theme reactively follows OS changes while the app is open.
- The mode/server shown are informational — they reflect the active config resolved at
  startup (`RC_API_MODE` / `RC_SERVER` / `RC_CLIENT_ID`), not user-editable toggles
  from this modal.

## MOCK-mode specifics

In MOCK mode the modal shows `Mode: mock`. Theme switching works identically in mock
and real mode (it's a pure renderer concern).

## Implementation references

- `src/renderer/components/SettingsModal.tsx` — theme picker, connection info, logout.
- `src/renderer/App.tsx` — applies the theme class (+ `prefers-color-scheme` listener).
- `src/renderer/store/appStore.ts` — `setTheme`, `doLogout`.
- `src/main/store.ts` — `updateSettings` (persistence).
- `src/main/ipc.ts` — `IPC.UPDATE_SETTINGS` handler.
