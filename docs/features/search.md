# Feature: Search

Find messages across all chats by text, and filter the conversation list by name.

## Actors

- **The user** — types a query to find a chat or a past message.

## Two search modes (single input)

The sidebar search input (`Sidebar.tsx`) drives two independent searches in parallel:

### 1. Chat-name filter (client-side)

As the user types, the chat list is filtered locally by `chatName(chat)` using a
case-insensitive substring match. This is instant and works offline. Clearing the
input restores the full list.

### 2. Message search (server-side)

Each keystroke (on change) calls `store.runSearch(api, query)`:

```
store.runSearch                                                          (appStore.ts)
   1. if query blank → clear search results; return
   2. set search = { query, results: [], loading: true }
   3. window.rcm.searchPosts(query)
      ─IPC search:posts──► client.searchPosts ─GET /team-messaging/v1/posts?searchText=<q>&recordCount=50
   4. set search = { query, results, loading: false }
   on error: clear loading, show toast
```

When results exist, a compact **"Message results"** dropdown appears under the input,
listing up to 8 matching messages. Clicking a result calls `selectChat(api, post.groupId)`
to jump to that message's conversation.

## Business rules

- **Empty query clears** both the filter (handled by the component) and the message
  results (handled by `runSearch`).
- The message search dropdown only renders when there are results; while loading or
  with zero hits, it's hidden so the chat list stays usable.
- Results are truncated to the top 50 matches and the dropdown shows the first 8.
- The chat-name filter is purely visual and never calls the API.

## MOCK-mode specifics

`MockMessagingClient.searchPosts` scans all in-memory posts across every chat and
returns those whose `text` contains the query case-insensitively.

## Implementation references

- `src/renderer/components/Sidebar.tsx` — input, chat-name filter, results dropdown.
- `src/renderer/store/appStore.ts` — `runSearch`.
- `src/shared/client/ringcentral.ts` — `searchPosts`.
- `src/shared/client/mock/mockClient.ts` — in-memory text scan.
