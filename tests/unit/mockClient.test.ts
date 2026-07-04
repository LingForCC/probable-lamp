import { describe, expect, it } from 'vitest'
import { MockMessagingClient } from '../../src/shared/client/mock/mockClient'
import type { RealtimeEnvelope } from '../../src/shared/types'

describe('MockMessagingClient', () => {
  it('seeds chats, teams, and posts', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    const chats = await c.listRecentChats()
    expect(chats.records.length).toBeGreaterThan(0)
    const teams = await c.listTeams()
    expect(teams.length).toBeGreaterThan(0)
    const posts = await c.listPosts('team-general')
    expect(posts.records.length).toBeGreaterThan(0)
  })

  it('returns the mock current user', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    const me = await c.getMe()
    expect(me.id).toBe('me')
  })

  it('sendPost appends a message authored by me and bumps the chat preview', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    c.login()
    c.setTokens(c.getTokens())
    const before = (await c.listPosts('team-general')).records.length
    const sent = await c.sendPost('team-general', 'hello team')
    expect(sent.isOwn).toBe(true)
    expect(sent.creatorId).toBe('me')
    const after = (await c.listPosts('team-general')).records.length
    expect(after).toBe(before + 1)
    const chats = await c.listRecentChats()
    const eng = chats.records.find((x) => x.id === 'team-general')!
    expect(eng.lastMessage).toBe('hello team')
  })

  it('listPosts paginates newest-first via pageToken', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    c.login()
    // Add several posts.
    for (let i = 0; i < 5; i++) await c.sendPost('team-general', `msg ${i}`)
    const page1 = await c.listPosts('team-general', { recordCount: 2 })
    expect(page1.records).toHaveLength(2)
    expect(page1.nextPageToken).toBeDefined()
    const page2 = await c.listPosts('team-general', {
      recordCount: 2,
      pageToken: page1.nextPageToken
    })
    // No overlap between pages.
    const ids1 = new Set(page1.records.map((p) => p.id))
    for (const p of page2.records) expect(ids1.has(p.id)).toBe(false)
  })

  it('editPost mutates text and lastModifiedTime', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    c.login()
    const sent = await c.sendPost('team-general', 'original')
    const edited = await c.editPost('team-general', sent.id, 'edited')
    expect(edited.text).toBe('edited')
    const posts = await c.listPosts('team-general')
    expect(posts.records.find((p) => p.id === sent.id)!.text).toBe('edited')
  })

  it('deletePost removes the post', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    c.login()
    const sent = await c.sendPost('team-general', 'bye')
    await c.deletePost('team-general', sent.id)
    const posts = await c.listPosts('team-general')
    expect(posts.records.find((p) => p.id === sent.id)).toBeUndefined()
  })

  it('createTeam adds a new team to the list', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    const before = (await c.listTeams()).length
    const team = await c.createTeam('New Project', [], 'A new team')
    expect(team.type).toBe('Team')
    expect(team.name).toBe('New Project')
    const after = (await c.listTeams()).length
    expect(after).toBe(before + 1)
  })

  it('listRecentChats records carry no unreadCount (unread is a renderer concern)', async () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    const chats = await c.listRecentChats()
    for (const chat of chats.records) {
      expect((chat as { unreadCount?: number }).unreadCount).toBeUndefined()
    }
  })

  it('emits a simulated reply via realtime after a send (when running)', async () => {
    const delivered: RealtimeEnvelope[] = []
    let tick: () => void = () => {}
    const c = new MockMessagingClient({
      autoReplyMs: 10,
      schedule: (fn) => {
        tick = fn
      }
    })
    c.onRealtime((env) => delivered.push(env))
    await c.start()
    c.login()
    c.setTokens(c.getTokens())
    await c.sendPost('team-general', 'hello')
    expect(delivered).toHaveLength(0)
    tick()
    expect(delivered).toHaveLength(1)
    const body = delivered[0].body as { eventType: string }
    expect(body.eventType).toBe('PostAdded')
    await c.stop()
  })

  it('login() installs a token set with sensible expiry', () => {
    const c = new MockMessagingClient({ autoReplyMs: 0 })
    const t = c.login()
    expect(t.access_token).toBeTruthy()
    expect(t.expires_in).toBeGreaterThan(0)
    expect(c.getTokens()?.access_token).toBe(t.access_token)
  })
})
