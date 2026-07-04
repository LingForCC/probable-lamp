# Feature: Send & Receive Messages

The core IM loop: read conversation history, type a message, send it, see it
appear, edit or delete it, and watch new messages arrive in realtime.

## Actors

- **Sender** — the current user composing a message.
- **Other members** — teammates whose messages you read; their incoming messages
  arrive via the realtime feature (see [realtime.md](realtime.md)).

## Sending a message (optimistic)

```
[Composer] Enter (no Shift)
   └─► store.sendText(api, text)                                   (appStore.ts)
         1. if no active chat or empty text → return
         2. create OPTIMISTIC post { localId, pending: true, isOwn: true }
         3. append to messages[chatId]   (UI updates immediately)
         4. window.rcm.sendPost ─IPC send:post──► client.sendPost ─POST /team-messaging/v1/chats/{id}/posts
         5. on 200: REPLACE localId → server post (pending=false), bump chat preview/time
         6. on error: mark post { pending:false, error } + show toast
```

The optimistic post is keyed by `localId`; when the server confirms, it's replaced
by the real post (keyed by server `id`). If the realtime `PostAdded` echo arrives
before the POST response, the dedupe in `applyRealtime` prevents a duplicate.

## Business rules (composer)

- **Enter sends**, **Shift+Enter inserts a newline** (`Composer.tsx`).
- **Empty/whitespace text is not sent.**
- **Textarea auto-grows** up to a 160px max, then scrolls.
- **Sending is disabled** while a previous send is in flight (`sending` state).
- After sending, focus returns to the composer and the field clears.
- **Mentions** use RingCentral syntax `![:Name](personId)`, rendered as chips
  (see Rendering below). Mentions/attachments are passed through to the API.

## Message history & pagination

- On `selectChat`, `GET /team-messaging/v1/chats/{id}/posts?recordCount=50` loads the most
  recent page, **newest first**. The `nextPageToken` is cached per chat.
- **Infinite scroll up**: when the list is scrolled to the top and `hasMore`,
  `loadMoreMessages` fetches the next page and **prepends** older messages while
  preserving the scroll anchor.
- Duplicate posts (by `localId ?? id`) are filtered on merge, so history + realtime
  never duplicate.

## Editing

```
hover own message → [Edit] ─► inline textarea ─► [Save]
   └─► store.editMessage(api, postId, text)                       (appStore.ts)
         1. mark post pending, swap text optimistically
         2. window.rcm.editPost ─IPC edit:post──► client.editPost ─PUT /team-messaging/v1/chats/{id}/posts/{postId}
         3. on 200: replace with server post
         4. on error: revert pending flag, set error
```

- Edit is only available on **your own** messages (hover action).
- Cancel restores the original text.
- An edited message shows "(edited)" when `lastModifiedTime !== creationTime`.

## Deleting

```
hover own message → [Delete] ─► confirm() dialog ─► store.deleteMessage
   1. REMOVE post optimistically from the list
   2. window.rcm.deletePost ─IPC delete:post──► client.deletePost ─DELETE /team-messaging/v1/chats/{id}/posts/{postId}
   (on error: show toast; the post stays removed locally)
```

- Delete is only available on **your own** messages and requires confirmation.

## Rendering

- **Markdown** is parsed by `marked` (GFM + line breaks): bold, lists, code blocks,
  links, blockquotes.
- **Mentions** `![:Name](id)` → highlighted `@Name` chips with a `data-mention-id`.
- Output is **sanitized** before render: `<script>`/`<iframe>` removed, event-handler
  attributes stripped, `javascript:` URLs neutralized (`src/renderer/lib/utils.ts`).
- **Grouping**: consecutive posts from the same author within 5 minutes share an
  avatar slot and omit the repeated header (`shouldGroupWith`).
- **Attachments**: `File`/`Event`/`Note`/`Task` render as chips; `Card` types render
  as titled cards.
- **Own messages** get a subtle background tint and an "You" author label.

## MOCK-mode specifics

- `MockMessagingClient.sendPost` appends a post authored by `me` and bumps the chat
  preview. After `autoReplyMs` (default 1500ms, only while `running`), it emits a
  simulated teammate reply as a `PostAdded` envelope (see [realtime.md](realtime.md)).
- Posts are stored newest-first in memory; `listPosts` paginates by index cursor.

## Implementation references

- `src/renderer/components/Composer.tsx` — input, key handling, typing throttle.
- `src/renderer/components/MessageList.tsx` — pagination/scroll, empty state.
- `src/renderer/components/MessageItem.tsx` — render, hover edit/delete, attachments.
- `src/renderer/lib/utils.ts` — `renderPostText`, `sanitizeHtml`, `shouldGroupWith`.
- `src/renderer/store/appStore.ts` — `sendText`, `editMessage`, `deleteMessage`,
  `selectChat`, `loadMoreMessages`.
- `src/shared/client/ringcentral.ts` — `listPosts`, `sendPost`, `editPost`, `deletePost`.
