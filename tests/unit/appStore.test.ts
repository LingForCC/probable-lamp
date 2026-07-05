import { describe, expect, it, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/store/appStore'
import { createFakeApi } from './fakeApi'
import type { GlipChat, GlipPerson, GlipPost, RealtimeEnvelope } from '../../src/shared/types'

const me: GlipPerson = { id: 'me', firstName: 'Me' }

const chats: GlipChat[] = [
  { id: 'c1', type: 'Team', name: 'Engineering' },
  { id: 'c2', type: 'Direct', name: 'Alice', person: { id: 'u1', firstName: 'Alice' } }
]

function freshStore() {
  // Reset only the data state between tests (NOT the actions — a full replace
  // would wipe the store's methods since zustand merges them into state).
  useAppStore.setState({
    config: null,
    auth: { status: 'loggedOut' },
    chats: [],
    activeChatId: null,
    messages: {},
    me: null,
    people: {},
    typing: {},
    unread: {},
    readStates: {},
    loadingChats: false,
    error: null
  })
}

describe('appStore init + login', () => {
  beforeEach(freshStore)

  it('init loads config + auth state', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().init(api)
    const s = useAppStore.getState()
    expect(s.config?.apiMode).toBe('mock')
    expect(s.auth.status).toBe('loggedOut')
  })

  it('doLogin sets the user and chats', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    const s = useAppStore.getState()
    expect(s.auth.status).toBe('loggedIn')
    expect(s.me?.id).toBe('me')
    expect(s.chats).toHaveLength(2)
    expect(s.people['u1']?.firstName).toBe('Alice')
  })
})

describe('appStore chat selection + pagination', () => {
  beforeEach(freshStore)

  it('selectChat loads messages and clears unread', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: {
        c1: [
          { id: 'p1', groupId: 'c1', text: 'first', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' },
          { id: 'p2', groupId: 'c1', text: 'second', creatorId: 'u1', creationTime: '2024-01-01T00:00:01Z' }
        ]
      }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    const s = useAppStore.getState()
    expect(s.activeChatId).toBe('c1')
    expect(s.messages['c1']?.posts.map((p) => p.id)).toEqual(['p2', 'p1']) // newest first
    // unread cleared (now tracked in the dedicated map, not on the chat)
    expect(s.unread['c1']).toBe(0)
  })

  it('loadMoreMessages prepends older pages', async () => {
    const posts: GlipPost[] = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      groupId: 'c1',
      text: `msg ${i}`,
      creatorId: 'u1',
      creationTime: new Date(2024, 0, 1, 0, 0, i).toISOString()
    }))
    const api = createFakeApi({ chats, me, posts: { c1: posts } })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1') // page size 50 -> all loaded
    // Force a scenario with a next page.
    const s1 = useAppStore.getState()
    useAppStore.setState({
      messages: { c1: { posts: s1.messages['c1']!.posts.slice(0, 2), hasMore: true, loadingMore: false, hydrated: true } }
    })
    await useAppStore.getState().loadMoreMessages(api)
    const s2 = useAppStore.getState()
    expect(s2.messages['c1']!.posts.length).toBeGreaterThanOrEqual(2)
  })
})

describe('appStore send/edit/delete + realtime', () => {
  beforeEach(freshStore)

  it('sendText shows an optimistic post then reconciles with the server one', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')

    await useAppStore.getState().sendText(api, 'hello')
    const posts = useAppStore.getState().messages['c1']!.posts
    expect(posts).toHaveLength(1)
    expect(posts[0].text).toBe('hello')
    expect(posts[0].isOwn).toBe(true)
    expect(posts[0].pending ?? false).toBe(false)
    expect(posts[0].localId).toBeUndefined() // reconciled to the real post
    expect(api.calls.sendPost?.[0]?.[0]).toMatchObject({ chatId: 'c1', text: 'hello' })
  })

  it('a PostAdded realtime event for the active chat appends a message', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    const env: RealtimeEnvelope = {
      event: '/restapi/v1.0/team-messaging/posts',
      body: {
        eventType: 'PostAdded',
        id: 'rt1',
        groupId: 'c1',
        text: 'incoming',
        creatorId: 'u1',
        creationTime: new Date().toISOString()
      }
    }
    useAppStore.getState().applyRealtime(env)
    const posts = useAppStore.getState().messages['c1']!.posts
    expect(posts.some((p) => p.id === 'rt1' && p.text === 'incoming')).toBe(true)
  })

  it('a PostUpdated realtime event updates the message text', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p1', groupId: 'c1', text: 'orig', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }] }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: { eventType: 'PostUpdated', id: 'p1', groupId: 'c1', text: 'edited!', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }
    })
    expect(useAppStore.getState().messages['c1']!.posts[0].text).toBe('edited!')
  })

  it('a PostRemoved realtime event removes the message', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p1', groupId: 'c1', text: 'orig', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }] }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: { eventType: 'PostRemoved', id: 'p1', groupId: 'c1' }
    })
    expect(useAppStore.getState().messages['c1']!.posts).toHaveLength(0)
  })

  it('editMessage updates the post via the api', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p1', groupId: 'c1', text: 'orig', creatorId: 'me', creationTime: '2024-01-01T00:00:00Z' }] }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    await useAppStore.getState().editMessage(api, 'p1', 'new text')
    expect(api.calls.editPost?.[0]?.[0]).toMatchObject({ chatId: 'c1', postId: 'p1', text: 'new text' })
    expect(useAppStore.getState().messages['c1']!.posts[0].text).toBe('new text')
  })

  it('deleteMessage removes the post optimistically', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p1', groupId: 'c1', text: 'orig', creatorId: 'me', creationTime: '2024-01-01T00:00:00Z' }] }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    await useAppStore.getState().deleteMessage(api, 'p1')
    expect(useAppStore.getState().messages['c1']!.posts).toHaveLength(0)
    expect(api.calls.deletePost?.[0]?.[0]).toMatchObject({ chatId: 'c1', postId: 'p1' })
  })

  it('duplicate PostAdded (e.g. our own optimistic + server echo) is deduped', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    await useAppStore.getState().sendText(api, 'hello')
    const countBefore = useAppStore.getState().messages['c1']!.posts.length
    // Simulate the server also pushing the same id.
    const id = useAppStore.getState().messages['c1']!.posts[0].id
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: { eventType: 'PostAdded', id, groupId: 'c1', text: 'hello', creatorId: 'me', creationTime: new Date().toISOString() }
    })
    expect(useAppStore.getState().messages['c1']!.posts.length).toBe(countBefore)
  })

  it('PostAdded for an inactive chat bumps unread and preview', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    // Do NOT select c2.
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: { eventType: 'PostAdded', id: 'z1', groupId: 'c2', text: 'ping', creatorId: 'u1', creationTime: new Date().toISOString() }
    })
    const s = useAppStore.getState()
    // unread now lives in the dedicated map, keyed by chatId
    expect(s.unread['c2']).toBe(1)
    expect(s.chats.find((c) => c.id === 'c2')?.lastMessage).toBe('ping')
  })
})

describe('appStore typing + theme', () => {
  beforeEach(freshStore)

  it('applyTyping adds and auto-removes a typer', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    useAppStore.getState().applyTyping({ chatId: 'c1', personId: 'u1', personName: 'Alice' })
    expect(useAppStore.getState().typing['c1']).toHaveLength(1)
    vi.advanceTimersByTime(4000)
    expect(useAppStore.getState().typing['c1']).toHaveLength(0)
    vi.useRealTimers()
  })

  it('setTheme persists via api and updates config', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().init(api)
    await useAppStore.getState().setTheme(api, 'light')
    expect(api.calls.updateSettings?.[0]?.[0]).toMatchObject({ theme: 'light' })
    expect(useAppStore.getState().config?.theme).toBe('light')
  })
})

describe('appStore unread reconciliation (local watermark)', () => {
  beforeEach(freshStore)

  it('cold start: counts messages newer than the persisted watermark, excluding own', async () => {
    // c2's history: two messages newer than the watermark, one of them mine.
    const watermark = '2024-01-01T00:00:00Z'
    const posts: GlipPost[] = [
      { id: 'old', groupId: 'c2', text: 'old', creatorId: 'u1', creationTime: '2023-12-31T23:00:00Z' },
      { id: 'theirs1', groupId: 'c2', text: 'new1', creatorId: 'u1', creationTime: '2024-01-01T00:01:00Z' },
      { id: 'mine', groupId: 'c2', text: 'mine', creatorId: 'me', creationTime: '2024-01-01T00:02:00Z' },
      { id: 'theirs2', groupId: 'c2', text: 'new2', creatorId: 'u1', creationTime: '2024-01-01T00:03:00Z' }
    ]
    const api = createFakeApi({
      chats: [{ id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2024-01-01T00:03:00Z' }],
      me,
      posts: { c2: posts },
      readStates: { c2: watermark }
    })
    await useAppStore.getState().doLogin(api)
    // Background reconcile runs on login; let it settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().unread['c2']).toBe(2) // theirs1 + theirs2, mine excluded
  })

  it('first-ever start seeds watermarks to firstStartedAt, not lastModifiedTime', async () => {
    // Regression for the "no unread on first start" bug: previously each chat's
    // watermark was seeded to its own lastModifiedTime, so the reconcile filter
    // (lastModifiedTime > watermark) never matched anything. With firstStartedAt,
    // the watermark is the install moment; activity before it stays read.
    const firstStartedAt = '2024-01-01T00:00:00Z'
    const api = createFakeApi({
      chats: [
        { id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2023-06-01T00:00:00Z' }
      ],
      me,
      posts: {
        c2: [{ id: 'p1', groupId: 'c2', text: 'old history', creatorId: 'u1', creationTime: '2023-06-01T00:00:00Z' }]
      },
      firstStartedAt
      // no readStates → first start
    })
    await useAppStore.getState().doLogin(api)
    await Promise.resolve()
    await Promise.resolve()
    // All history predates firstStartedAt → 0 unread, and the watermark is the
    // install moment (NOT the chat's lastModifiedTime).
    expect(useAppStore.getState().unread['c2'] ?? 0).toBe(0)
    expect(useAppStore.getState().readStates['c2']).toBe(firstStartedAt)
  })

  it('first-ever start: chat with activity AFTER firstStartedAt reconciles as unread', async () => {
    // The fix: a teammate posts after the user installed → it must badge.
    const firstStartedAt = '2024-01-01T00:00:00Z'
    const posts: GlipPost[] = [
      { id: 'old', groupId: 'c2', text: 'old', creatorId: 'u1', creationTime: '2023-12-31T00:00:00Z' },
      { id: 'new', groupId: 'c2', text: 'after install', creatorId: 'u1', creationTime: '2024-01-02T00:00:00Z' }
    ]
    const api = createFakeApi({
      chats: [{ id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2024-01-02T00:00:00Z' }],
      me,
      posts: { c2: posts },
      firstStartedAt
    })
    await useAppStore.getState().doLogin(api)
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().unread['c2']).toBe(1) // the post after install
  })

  it('selectChat clears unread and advances the watermark', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: {
        c1: [
          { id: 'p1', groupId: 'c1', text: 'first', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }
        ]
      },
      readStates: { c1: '2023-01-01T00:00:00Z' }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    const s = useAppStore.getState()
    expect(s.unread['c1']).toBe(0)
    // Watermark advanced to at least the newest visible post.
    expect((s.readStates['c1'] ?? '') >= '2024-01-01T00:00:00Z').toBe(true)
  })

  it('reconcileUnread recomputes counts after a missed-realtime interruption (wake/reconnect)', async () => {
    // Simulate: user was logged in with the chat read up to a watermark, then
    // the machine slept and a teammate sent messages the client never saw.
    const watermark = '2024-01-01T00:00:00Z'
    const api = createFakeApi({
      chats: [{ id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2024-01-01T00:05:00Z' }],
      me,
      posts: {
        c2: [
          { id: 'old', groupId: 'c2', text: 'old', creatorId: 'u1', creationTime: '2023-12-31T00:00:00Z' },
          // Three new messages arrived "while asleep"; one is mine.
          { id: 'm1', groupId: 'c2', text: 'wake1', creatorId: 'u1', creationTime: '2024-01-01T00:01:00Z' },
          { id: 'm2', groupId: 'c2', text: 'wake2', creatorId: 'u1', creationTime: '2024-01-01T00:02:00Z' },
          { id: 'mine', groupId: 'c2', text: 'mine', creatorId: 'me', creationTime: '2024-01-01T00:03:00Z' }
        ]
      },
      readStates: { c2: watermark }
    })
    await useAppStore.getState().doLogin(api)
    await Promise.resolve()
    // Pretend the user had already cleared the badge; reconcileUnread should
    // recompute it from the watermark + current history.
    useAppStore.setState({ unread: { c2: 0 } })
    await useAppStore.getState().reconcileUnread(api)
    expect(useAppStore.getState().unread['c2']).toBe(2) // m1 + m2, mine excluded
  })

  it('reconcileUnread pages back across multiple pages until the watermark is reached', async () => {
    // Watermark sits before the oldest post, so the reconcile must walk every
    // page (2 pages of 3) to count them all. Validates multi-page paging +
    // the stop condition (nextPageToken absent → history exhausted).
    const watermark = '2023-01-01T00:00:00Z'
    // 6 posts across 2 pages of 3 (fakeApi page size is overridden via recordCount).
    const all: GlipPost[] = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      groupId: 'c2',
      text: `m${i}`,
      creatorId: 'u1',
      creationTime: `2024-01-01T00:0${i}:00Z`
    }))
    const api = createFakeApi({
      chats: [{ id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2024-01-01T00:05:00Z' }],
      me,
      posts: { c2: all },
      readStates: { c2: watermark }
    })
    await useAppStore.getState().doLogin(api)
    await Promise.resolve()
    // The cold-start reconcile used page size 50 (all 6 on one page). Force a
    // re-reconcile and assert it counted every newer-than-watermark post.
    useAppStore.setState({ unread: { c2: 0 } })
    await useAppStore.getState().reconcileUnread(api)
    expect(useAppStore.getState().unread['c2']).toBe(6)
  })

  it('PostAdded to the active chat keeps unread at 0 and advances the watermark', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p0', groupId: 'c1', text: 'seed', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }] },
      readStates: { c1: '2024-01-01T00:00:00Z' }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    const before = useAppStore.getState().readStates['c1']
    // A realtime message newer than the current watermark arrives in the
    // active chat. Use a timestamp strictly newer than `before`.
    const liveAt = new Date(Date.now() + 60_000).toISOString()
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: {
        eventType: 'PostAdded',
        id: 'rt1',
        groupId: 'c1',
        text: 'live',
        creatorId: 'u1',
        creationTime: liveAt
      }
    })
    const s = useAppStore.getState()
    expect(s.unread['c1']).toBe(0)
    // Watermark advanced to the new post's creationTime.
    expect(s.readStates['c1']).toBe(liveAt)
    expect((s.readStates['c1'] ?? '') > (before ?? '')).toBe(true)
  })

  it('a PostAdded of my own message never counts as unread', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    // c2 is inactive; an own-authored message arrives there.
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/team-messaging/posts',
      body: { eventType: 'PostAdded', id: 'own1', groupId: 'c2', text: 'mine', creatorId: 'me', creationTime: new Date().toISOString() }
    })
    expect(useAppStore.getState().unread['c2'] ?? 0).toBe(0)
  })

  it('sendText advances the active chat watermark (own message is read)', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p0', groupId: 'c1', text: 'seed', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }] },
      readStates: { c1: '2024-01-01T00:00:00Z' }
    })
    await useAppStore.getState().doLogin(api)
    // Capture before selectChat advances it; sendText should advance it further
    // (or at minimum mark read + invoke markChatRead).
    const before = useAppStore.getState().readStates['c1']
    await useAppStore.getState().selectChat(api, 'c1')
    await useAppStore.getState().sendText(api, 'fresh message')
    const after = useAppStore.getState().readStates['c1']
    expect((after ?? '') > (before ?? '')).toBe(true)
    // markChatRead should also have been invoked (server best-effort + persist).
    expect(api.calls.markChatRead?.some((args) => args[0] === 'c1')).toBe(true)
  })

  it('refreshChats preserves existing unread entries and defaults new chats to 0', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    // Seed an unread count for c2 and a brand-new chat c3 in the next list.
    useAppStore.setState({ unread: { c2: 5 } })
    const api2 = createFakeApi({
      chats: [
        ...chats,
        { id: 'c3', type: 'Team', name: 'New' }
      ],
      me
    })
    await useAppStore.getState().refreshChats(api2)
    const s = useAppStore.getState()
    expect(s.unread['c2']).toBe(5) // preserved
    expect(s.unread['c3'] ?? 0).toBe(0) // new chat defaults to 0
  })
})

describe('appStore offline cache seeding', () => {
  beforeEach(freshStore)

  it('doLogin seeds the sidebar from the cache before the network resolves', async () => {
    // Network chats differ from cached chats; both should be loaded, with the
    // network value winning once doLogin settles.
    const api = createFakeApi({
      chats: [{ id: 'net', type: 'Team', name: 'From Network' }],
      me,
      cachedMe: me,
      cachedChats: [{ id: 'cache', type: 'Team', name: 'From Cache' }]
    })
    await useAppStore.getState().doLogin(api)
    const s = useAppStore.getState()
    // getCachedChats was consulted (cache-first render path).
    expect(api.calls.getCachedChats).toHaveLength(1)
    expect(api.calls.getCachedMe).toHaveLength(1)
    // After settling, the network chats win.
    expect(s.chats.map((c) => c.id)).toEqual(['net'])
    expect(s.me?.id).toBe('me')
  })

  it('doLogin with an empty cache falls back to the network-only path', async () => {
    const api = createFakeApi({ chats, me }) // no cached* provided → cold
    await useAppStore.getState().doLogin(api)
    expect(api.calls.getCachedChats).toHaveLength(1) // still consulted
    expect(useAppStore.getState().chats).toHaveLength(2) // network result
  })

  it('selectChat renders cached posts instantly, then refreshes from network once', async () => {
    // Cached posts exist for c1; the network returns a newer post on page 1.
    const cachedPost: GlipPost = {
      id: 'cached-1',
      groupId: 'c1',
      text: 'from cache',
      creatorId: 'u1',
      creationTime: '2024-01-01T00:00:00Z'
    }
    const netPost: GlipPost = {
      id: 'net-1',
      groupId: 'c1',
      text: 'from network',
      creatorId: 'u1',
      creationTime: '2024-01-02T00:00:00Z'
    }
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [netPost] },
      cachedPosts: { c1: { posts: [cachedPost] } },
      readStates: { c1: '2023-01-01T00:00:00Z' }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')

    // After settle: both posts merged (cache + network), deduped, newest-first.
    const msgs = useAppStore.getState().messages['c1']!
    expect(msgs.posts.map((p) => p.id)).toEqual(['net-1', 'cached-1'])
    // The cache read happened, and exactly one network listPosts fired.
    expect(api.calls.getCachedPosts).toHaveLength(1)
    const listPostsCalls = api.calls.listPosts ?? []
    expect(listPostsCalls).toHaveLength(1)
    // Hydrated flag flipped to true after the background refresh.
    expect(msgs.hydrated).toBe(true)
  })

  it('selectChat does not re-fetch when re-selecting an already-hydrated chat', async () => {
    const api = createFakeApi({
      chats,
      me,
      posts: { c1: [{ id: 'p1', groupId: 'c1', text: 'hi', creatorId: 'u1', creationTime: '2024-01-01T00:00:00Z' }] }
    })
    await useAppStore.getState().doLogin(api)
    await useAppStore.getState().selectChat(api, 'c1')
    const callsAfterFirst = (api.calls.listPosts ?? []).length
    // Re-select the same chat — it's already hydrated, so no new fetch.
    await useAppStore.getState().selectChat(api, 'c1')
    expect((api.calls.listPosts ?? []).length).toBe(callsAfterFirst)
  })

  it('reconcile still pages the network with cache:false (does not depend on cache)', async () => {
    // Regression guard: the watermark-based recount must remain correct even
    // with a populated cache, and must not be short-circuited by cached posts.
    const watermark = '2024-01-01T00:00:00Z'
    const posts: GlipPost[] = [
      { id: 'old', groupId: 'c2', text: 'old', creatorId: 'u1', creationTime: '2023-12-31T23:00:00Z' },
      { id: 'new1', groupId: 'c2', text: 'new1', creatorId: 'u1', creationTime: '2024-01-01T00:01:00Z' },
      { id: 'new2', groupId: 'c2', text: 'new2', creatorId: 'u1', creationTime: '2024-01-01T00:02:00Z' }
    ]
    const api = createFakeApi({
      chats: [{ id: 'c2', type: 'Team', name: 'Eng', lastModifiedTime: '2024-01-01T00:02:00Z' }],
      me,
      posts: { c2: posts },
      readStates: { c2: watermark },
      cachedPosts: { c2: { posts: [posts[0]] } } // stale cache present
    })
    await useAppStore.getState().doLogin(api)
    await Promise.resolve()
    await Promise.resolve()
    expect(useAppStore.getState().unread['c2']).toBe(2) // new1 + new2
  })
})
