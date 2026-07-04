# Feature: Search

Filter the conversation list by name.

## Actors

- **The user** — types a query to find a chat by name.

## Chat-name filter (client-side)

The sidebar search input (`Sidebar.tsx`) filters the chat list locally by
`chatName(chat)` using a case-insensitive substring match. This is instant and
works offline. Clearing the input restores the full list.

```
Sidebar.tsx
   onChange → setFilter(value)
   filtered = chats.filter(c => chatName(c).toLowerCase().includes(filter))
```

The chat-name filter is purely visual and never calls the API.

## Implementation references

- `src/renderer/components/Sidebar.tsx` — input + chat-name filter.
