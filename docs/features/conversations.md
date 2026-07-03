# Feature: Conversations Sidebar

Browse and switch between all of the user's chats (teams, groups, direct messages),
see unread state, and filter by name.

## Actors

- **The user** — picks a conversation to open.

## Data source

`GET /glip/chats?recordCount=250` once after login (`store.doLogin` → `listChats`).
Each `GlipChat` has a `type` (`Personal` | `Group` | `Team` | `Direct` | `Everyone`),
an optional `name`, the other `person` for direct chats, a `lastMessage` preview,
`lastModifiedTime`, `membersCount`, and `unreadCount`.

## Sidebar rendering (`Sidebar.tsx`)

- Sorted/grouped as returned by the API; each row shows an **avatar** (image or
  initials with a deterministic color), the chat name, the relative last-activity
  time, the last message preview, and an **unread badge** if `unreadCount > 0`.
- The workspace header shows the current user and total unread across all chats.
- A "New team" button opens the create-team modal (see [teams.md](teams.md)).

### Chat name resolution (`chatName`)

`name` → else `"<first> <last>"` of the `person` (direct) → else `"Everyone"` /
`"Conversation"`. Used for both display and the search filter.

## Selecting a chat

```
click chat row ─► store.selectChat(api, chatId)                      (appStore.ts)
   1. set activeChatId
   2. if messages already loaded → just markChatRead; return
   3. else GET /glip/chats/{id}/posts (first page)
   4. markChatRead (IPC) + clear that chat's unread badge in the sidebar
```

- The selected row gets a highlighted background.
- The active chat is rendered by `ChatView` (see [send-receive.md](send-receive.md)).

## Search / filter

The search input does double duty:

1. **Client-side filter**: as you type, the row list is filtered by `chatName`
   (case-insensitive substring). Clearing the input restores the full list.
2. **Server-side message search**: typing also calls `runSearch` which runs
   `client.searchPosts(query)` and, if there are hits, shows a compact "Message
   results" dropdown; clicking a result jumps to that post's chat
   (see [search.md](search.md)).

## Realtime updates to the sidebar

When a `PostAdded` event arrives, `applyRealtime` updates the relevant chat row's
`lastMessage` (truncated to 80 chars), `lastModifiedTime`, and bumps `unreadCount`
(unless it's the active chat → stays 0). The sidebar re-renders reactively from the
store. After creating a team, `refreshChats` reloads the list so the new team appears.

## MOCK-mode specifics

`MockMessagingClient` seeds 4 chats (Engineering team with 2 unread, Design team,
a direct chat with Alice with 1 unread, a "Lunch Club" group) plus seeded message
history. `markChatRead` clears the unread count in memory.

## Implementation references

- `src/renderer/components/Sidebar.tsx` — list, filter, unread badges, search box.
- `src/renderer/store/appStore.ts` — `selectChat`, `refreshChats`, `runSearch`,
  realtime chat-row updates.
- `src/shared/client/ringcentral.ts` — `listChats`, `markChatRead`.
- `src/shared/client/mock/mockClient.ts` — seeded chats + `markChatRead`.
