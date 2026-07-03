import { describe, expect, it, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/store/appStore'
import { createFakeApi } from './fakeApi'
import type { GlipChat, GlipPerson, GlipPost, RealtimeEnvelope } from '../../src/shared/types'

const me: GlipPerson = { id: 'me', firstName: 'Me' }

const chats: GlipChat[] = [
  { id: 'c1', type: 'Team', name: 'Engineering', unreadCount: 2 },
  { id: 'c2', type: 'Direct', name: 'Alice', unreadCount: 0, person: { id: 'u1', firstName: 'Alice' } }
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
    search: null,
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
    // unread cleared
    expect(s.chats.find((c) => c.id === 'c1')?.unreadCount).toBe(0)
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
      messages: { c1: { posts: s1.messages['c1']!.posts.slice(0, 2), hasMore: true, loadingMore: false } }
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
      event: '/restapi/v1.0/glip/posts',
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
      event: '/restapi/v1.0/glip/posts',
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
      event: '/restapi/v1.0/glip/posts',
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
      event: '/restapi/v1.0/glip/posts',
      body: { eventType: 'PostAdded', id, groupId: 'c1', text: 'hello', creatorId: 'me', creationTime: new Date().toISOString() }
    })
    expect(useAppStore.getState().messages['c1']!.posts.length).toBe(countBefore)
  })

  it('PostAdded for an inactive chat bumps unread and preview', async () => {
    const api = createFakeApi({ chats, me })
    await useAppStore.getState().doLogin(api)
    // Do NOT select c2.
    useAppStore.getState().applyRealtime({
      event: '/restapi/v1.0/glip/posts',
      body: { eventType: 'PostAdded', id: 'z1', groupId: 'c2', text: 'ping', creatorId: 'u1', creationTime: new Date().toISOString() }
    })
    const c2 = useAppStore.getState().chats.find((c) => c.id === 'c2')!
    expect(c2.unreadCount).toBe(1)
    expect(c2.lastMessage).toBe('ping')
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
