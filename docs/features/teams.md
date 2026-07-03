# Feature: Teams

List existing teams and create new named teams.

## Actors

- **The user** — creates or browses teams.

## Listing

Teams are a special kind of chat (`type: 'Team'`) and are included in the general
chat list (see [conversations.md](conversations.md)). `GET /glip/teams` is available
for an explicit teams list (`IPC.LIST_TEAMS` / `client.listTeams`), and a single team
can be fetched via `GET /glip/teams/{chatId}` (`getTeam`).

## Creating a team

```
[New team] button ─► CreateTeamModal                              (CreateTeamModal.tsx)
   fields: Name (required), Description (optional)
   [Create team]
     1. validate name non-empty (else show inline error)
     2. window.rcm.createTeam({ name, members?, description? })
        ─IPC create:team──► client.createTeam ─POST /glip/teams { name, description, members }
     3. on success: store.refreshChats(api)   (so the new team appears in the sidebar)
     4. close modal
     on error: show inline error, keep modal open
```

- The team is created server-side with the current user as a member; `members` is an
  optional array of person ids (defaults to empty).
- After creation, `refreshChats` re-fetches the chat list so the new team shows up
  immediately and can be selected like any other conversation.

## Business rules

- **Name is required**; the submit button shows an inline error if blank.
- The submit button is disabled (shows "Creating…") while the request is in flight.
- Description is optional and passed through only when non-empty.

## MOCK-mode specifics

`MockMessagingClient.createTeam` creates an in-memory `Team` (id, name, description,
member count = 1 + members), registers it in both the `teams` and `chats` maps, and
gives it an empty message history. `listTeams` returns all seeded + created teams.

## Implementation references

- `src/renderer/components/CreateTeamModal.tsx` — form, validation, create + refresh.
- `src/renderer/store/appStore.ts` — `refreshChats`.
- `src/shared/client/ringcentral.ts` — `createTeam`, `listTeams`, `getTeam`.
- `src/shared/client/mock/mockClient.ts` — in-memory team creation.
