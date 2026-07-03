# Feature: Desktop Notifications

Fire an OS-level notification for new incoming messages, without nagging the user.

## Actors

- **The current user** — receives notifications only when appropriate.
- **Electron `Notification`** — the platform notification surface.

## When does a notification fire?

For every inbound realtime envelope, `IpcController.maybeNotify` calls
`shouldNotify(event, me, isFocused)` (`src/main/notifications.ts`). A notification
fires **only if all of these pass**, evaluated in order:

| # | Rule | Effect |
| --- | --- | --- |
| 1 | `event.eventType === 'PostAdded'` | Edits/removals never notify. |
| 2 | `event.creatorId !== me?.id` | Your own messages never notify. |
| 3 | the window is **not** focused | If you're already looking at the app, suppress it. |
| 4 | `!shown.has(event.id)` | Each post notifies at most once (dedupe). |

If all pass, the post id is added to the `shown` set **before** displaying (so a
display failure still counts as "shown"), and `showPostNotification` is called.

> **Active-chat caveat:** the current implementation notifies for *any* new inbound
> post that passes the rules above — it does **not** additionally suppress posts for
> the currently-open chat. The "window focused" rule is the primary guard.

## Notification content

- **Title**: `"<sender name> in <chat name>"`, or `"New message in <chat name>"` when
  the sender can't be resolved.
- **Body**: a cleaned preview of the message text (`stripPreview`):
  - code fences → `[code]`
  - markdown link/image syntax removed
  - `# > * _ ` ~` characters stripped
  - truncated to 140 chars with an ellipsis.

The sender is resolved via `IpcController.resolvePerson` (best-effort; may be null).
The chat name is currently passed as a fixed `"Chat"` from `maybeNotify`.

## Dedupe behavior

- The `shown` set is **process-lifetime** with no TTL and is only cleared by
  `resetNotificationDedupe()` (test-only).
- Dedupe is by post id, so a realtime replay (e.g. session recovery) won't re-notify.

## Robustness

- `electronNotification` no-ops silently if `Notification.isSupported()` is false or
  on any throw, so notifications can never crash the realtime path.

## Implementation references

- `src/main/notifications.ts` — `shouldNotify`, `showPostNotification`, `stripPreview`.
- `src/main/ipc.ts` — `maybeNotify` (gating + sender resolution).
