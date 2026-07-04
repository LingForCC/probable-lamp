# Feature: Conversations Sidebar

Browse and switch between all of the user's chats (teams, groups, direct messages),
see unread state, and filter by name.

## Actors

- **The user** — picks a conversation to open.

## Data source

`GET /team-messaging/v1/recent/chats?recordCount=250` once after login (`store.doLogin` → `listRecentChats`). The "recent" endpoint returns only chats the user is a member of, sorted by `lastModifiedTime` descending (matching the sidebar), and is Light-throttled.
Each `GlipChat` has a `type` (`Personal` | `Group` | `Team` | `Direct` | `Everyone`),
an optional `name`, the other `person` for direct chats, a `lastMessage` preview,
`lastModifiedTime`, and `membersCount`. (The server also returns an `unreadCount`
field — it is **ignored**. See "Unread (local)" below.)

### Offline history cache

The chat list, the current user, and per-chat posts are mirrored to disk as
per-chat JSON under `<userData>/message-cache/` (`CacheStore`), so the sidebar
and an opened chat render **instantly on cold start** and remain viewable
offline. (Named `message-cache`, not `cache`, to avoid colliding with
Chromium's reserved `<userData>/Cache/` HTTP-cache directory on
case-insensitive filesystems.)

- **Write-through** happens in the IPC layer on every `listRecentChats` /
  `getMe` / `listPosts` fetch and on realtime `PostAdded`/`PostUpdated`/
  `PostRemoved`; `sendPost` / `editPost` / `deletePost` mirror too.
- **Read-back** is cache-first: `init`/`doLogin` seed `me` + `chats` from disk
  before the network resolves, and `selectChat` renders cached posts immediately
  then refreshes page 1 once in the background (tracked by a `hydrated` flag so
  it doesn't re-fetch on every re-select).
- **Retention:** capped at the newest **500 posts per chat** (FIFO eviction of
  oldest); older history is always re-fetchable via "load more".
- **Clear policy:** the cache survives restarts, sleeps, and token re-exchange,
  and is **wiped on explicit logout** (alongside tokens).
- Plaintext — same trust boundary as the watermark previews already shown in the
  sidebar. A future option is `safeStorage` encryption at rest.

> The cache is strictly **subservient** to the unread logic below: the
> watermark-based recount passes `cache: false` so counting never churns the
> disk, and `unread` is governed solely by the watermarks — never by what
> happens to be cached.

## Unread (local, watermark-based)

Unread counts are computed and maintained **entirely client-side**; the server's
`unreadCount` is never trusted. The model:

- `lastReadTime[chatId]` — a persisted watermark: the ISO timestamp of the newest
  message the user has seen in that chat. Stored to disk via `electron-store`
  (`AppStore.readStates`, plaintext) so it survives restarts.
- `unread[chatId]` — the count shown in the sidebar (Zustand store). A message is
  unread iff `creationTime > lastReadTime[chatId]` and it isn't the user's own.

### Lifecycle

1. **First-ever start** (no persisted watermarks): seed
   `lastReadTime[chatId] = chat.lastModifiedTime` for every chat → 0 unread, so
   history isn't shown as unread. (In MOCK mode, demo watermarks are seeded
   instead so the seeded chats display their classic unread badges.)
2. **Cold start** (watermarks persisted, app was closed): the sidebar renders
   instantly from the offline cache (if any), then for each chat where
   `lastModifiedTime > lastReadTime[chatId]`, page back through recent posts
   (page size 500, newest-first) until a post at or before the watermark is hit,
   counting non-own messages newer than the watermark. Runs in the background
   after the sidebar renders; badges fill in per-chat as each fetch completes
   (concurrency capped at 5). Chats with no new activity stay at 0 with zero
   requests. A safety-valve (20 pages) guards against pathological data. The
   recount passes `cache: false` so it never churns the offline cache.
3. **Warm realtime** (`PostAdded`): inactive chat → `unread += 1`; active chat →
   advance the watermark to the new post and stay at 0.
4. **Select a chat** (`selectChat`): clear `unread`, advance the watermark to the
   newest visible message, and call `markChatRead` (server best-effort + persists
   the watermark via the IPC layer). Cached posts render first; a one-time
   background refresh merges in anything newer.
5. **Send a message** (`sendText`): own message in the active chat → advance the
   watermark so it's never counted as unread.
6. **App open but interrupted** (machine asleep / network dropped): realtime
   `PostAdded` events are missed and the WebSocket can sit stale (its keepalive
   timer doesn't tick during sleep). On **system resume** (`powerMonitor`'s
   `resume` event) main force-reconnects the socket, and on **any realtime
   reconnect** (the socket's `onReconnect` hook) main pushes a
   `REALTIME_RECONCILED` signal — both debounced 5s so a wake that also triggers
   a reconnect fires once. The renderer's `reconcileUnread` then re-runs
   `refreshChats` + the same watermark-based page-back reconcile as cold start,
   recomputing counts from history. Session recovery may be exhausted for long
   sleeps, which is exactly why the recount re-runs. Idempotent.

## Sidebar rendering (`Sidebar.tsx`)

- Sorted/grouped as returned by the API; each row shows an **avatar** (image or
  initials with a deterministic color), the chat name, the relative last-activity
  time, the last message preview, and an **unread badge** sourced from the
  `unread` map (`unread[chat.id] > 0`).
- The workspace header shows the current user and total unread (sum of the
  `unread` map) across all chats.
- A "New team" button opens the create-team modal (see [teams.md](teams.md)).

### Chat name resolution (`chatName`)

`name` → else `"<first> <last>"` of the `person` (direct) → else `"Everyone"` /
`"Conversation"`. Used for both display and the search filter.

## Selecting a chat

```
click chat row ─► store.selectChat(api, chatId)                      (appStore.ts)
   1. set activeChatId
   2. if messages already loaded → markChatRead locally (clear unread, advance
      watermark) + server best-effort; return
   3. else GET /team-messaging/v1/chats/{id}/posts (first page)
   4. markChatRead locally: clear unread[chatId], advance lastReadTime[chatId]
      to the newest visible message, and call api.markChatRead (which the IPC
      layer also persists to the read-state store)
```

- The selected row gets a highlighted background.
- The active chat is rendered by `ChatView` (see [send-receive.md](send-receive.md)).

## Search / filter

The search input filters the row list by `chatName` (case-insensitive substring).
Clearing the input restores the full list. This is purely client-side and never
calls the API (see [search.md](search.md)).

## Realtime updates to the sidebar

When a `PostAdded` event arrives, `applyRealtime` updates the relevant chat row's
`lastMessage` (truncated to 80 chars) and `lastModifiedTime`, and updates the
`unread` map: the active chat stays at 0 (and its watermark advances to the new
post), any other chat gets `+1`. Own messages never count as unread. The sidebar
re-renders reactively from the store. After creating a team, `refreshChats`
reloads the list so the new team appears.

## MOCK-mode specifics

`MockMessagingClient` seeds 4 chats (Engineering team, Design team, a direct chat
with Alice, a "Lunch Club" group) plus seeded message history. It no longer tracks
unread at all — that's purely a renderer concern. To preserve the demo experience,
the renderer seeds read-state watermarks on first login in mock mode so the
Engineering and Alice chats show unread badges (2 and 1) via the normal cold-start
reconcile path.

## Implementation references

- `src/renderer/components/Sidebar.tsx` — list, filter, unread badges, search box.
- `src/renderer/store/appStore.ts` — `selectChat`, `refreshChats`, `reconcileUnread`,
  `seedReadStatesAndUnread`, `reconcileUnreadForAll`, realtime chat-row
  updates.
- `src/renderer/main.tsx` — subscribes to `onRealtimeReconciled` → `reconcileUnread`.
- `src/main/store.ts` — `getReadStates` / `setReadState` (persisted watermarks).
- `src/main/ipc.ts` — `notifyRealtimeReconnected` (debounced `REALTIME_RECONCILED`).
- `src/main/index.ts` — `powerMonitor.on('resume')` + socket `onReconnect` wiring.
- `src/shared/client/websocket.ts` — `onReconnect` option, `forceReconnect()`.
- `src/shared/client/ringcentral.ts` — `listRecentChats`, `markChatRead`.
- `src/shared/client/mock/mockClient.ts` — seeded chats.
