# Feature Documentation

Each file in this directory describes one business feature of RC Messenger: its
purpose, the actors involved, the step-by-step workflow, the business rules and
edge cases, and the code that implements it (with file:line references).

| Feature | File | Summary |
| --- | --- | --- |
| Authentication & sessions | [auth.md](auth.md) | OAuth Authorization Code + PKCE login, token lifecycle, encrypted storage, logout. |
| Send & receive messages | [send-receive.md](send-receive.md) | Composing, optimistic send, history pagination, edit, delete, Markdown + mentions. |
| Realtime updates | [realtime.md](realtime.md) | WebSocket subscription, PostAdded/Updated/Removed handling, session recovery, reconnect. |
| Typing indicators | [typing.md](typing.md) | Outbound typing throttling, inbound display, auto-clear. |
| Desktop notifications | [notifications.md](notifications.md) | When a notification fires, dedupe, and gating rules. |
| Conversations sidebar | [conversations.md](conversations.md) | Chat list, unread badges, search/filter, selection. |
| Teams | [teams.md](teams.md) | Listing and creating teams. |
| Search | [search.md](search.md) | Searching messages across chats. |
| Settings & theming | [settings.md](settings.md) | Theme, server/mode display, logout. |

> These docs describe the **actual implemented behavior** of the code in this repo.
> MOCK-mode specifics (how the fake backend simulates realtime, auto-replies, etc.)
> are called out inline where they differ from the real RingCentral API behavior.
