import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Real-persistence tests for CacheStore (per-chat JSON files).
 *
 * The module imports `electron` only for `app.getPath('userData')`, which we
 * mock so tests can inject a temp dir via the constructor instead.
 */
vi.mock('electron', () => ({ app: { getPath: () => '/__unused__' } }))
import { CacheStore } from '../../src/main/cacheStore'
import type { GlipChat, GlipPerson, GlipPost } from '../../src/shared/types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function post(id: string, chatId: string, time: string, extra: Partial<GlipPost> = {}): GlipPost {
  return { id, groupId: chatId, creatorId: 'u1', text: id, creationTime: time, ...extra }
}

const me: GlipPerson = { id: 'me', firstName: 'Me' }
const chats: GlipChat[] = [{ id: 'c1', type: 'Team', name: 'Engineering' }]

describe('CacheStore index (me + chats)', () => {
  it('returns null when the cache is cold', () => {
    const cache = new CacheStore(dir)
    expect(cache.readIndex()).toBeNull()
  })

  it('writes and reads back me + chats', () => {
    const cache = new CacheStore(dir)
    cache.writeMe(me)
    cache.writeChats(chats)
    const idx = cache.readIndex()
    expect(idx?.me?.id).toBe('me')
    expect(idx?.chats).toEqual(chats)
  })

  it('survives a restart (a new CacheStore instance reads the same dir)', () => {
    const cache = new CacheStore(dir)
    cache.writeMe(me)
    cache.writeChats(chats)
    const restarted = new CacheStore(dir)
    expect(restarted.readIndex()?.me?.id).toBe('me')
    expect(restarted.readIndex()?.chats).toEqual(chats)
  })

  it('updates me without dropping chats, and vice versa', () => {
    const cache = new CacheStore(dir)
    cache.writeChats(chats)
    cache.writeMe(me)
    const me2: GlipPerson = { id: 'me2', firstName: 'Two' }
    cache.writeMe(me2)
    const idx = cache.readIndex()
    expect(idx?.me?.id).toBe('me2')
    expect(idx?.chats).toHaveLength(1)
  })
})

describe('CacheStore posts', () => {
  it('returns null when no posts are cached for a chat', () => {
    const cache = new CacheStore(dir)
    expect(cache.readPosts('c1')).toBeNull()
  })

  it('writes and reads back posts (newest-first)', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [
      post('p1', 'c1', '2024-01-01T00:00:00Z'),
      post('p2', 'c1', '2024-01-02T00:00:00Z')
    ])
    const file = cache.readPosts('c1')
    expect(file?.posts.map((p) => p.id)).toEqual(['p2', 'p1']) // sorted desc
    expect(file?.nextPageToken).toBeUndefined()
  })

  it('merges and dedupes on subsequent writes (by id)', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')])
    cache.writePosts('c1', [
      post('p1', 'c1', '2024-01-01T00:00:00Z'), // duplicate id
      post('p2', 'c1', '2024-01-02T00:00:00Z')
    ])
    const ids = cache.readPosts('c1')!.posts.map((p) => p.id)
    expect(ids).toEqual(['p2', 'p1'])
  })

  it('dedupes by localId when present (optimistic vs server echo)', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [
      post('local-1', 'c1', '2024-01-01T00:00:00Z', { localId: 'local-1', pending: true })
    ])
    // Server confirms with a different id but the same localId should replace.
    cache.upsertPost('c1', post('server-1', 'c1', '2024-01-01T00:00:00Z', { localId: 'local-1' }))
    const ids = cache.readPosts('c1')!.posts.map((p) => p.id)
    expect(ids).toEqual(['server-1'])
  })

  it('caps at 500 posts, keeping the newest', () => {
    const cache = new CacheStore(dir)
    // 600 posts, ascending in time; the newest 500 should survive. Use a base
    // date and increment minutes so ISO strings sort lexicographically.
    const base = new Date('2024-01-01T00:00:00Z').getTime()
    const many = Array.from({ length: 600 }, (_, i) =>
      post(`p${i}`, 'c1', new Date(base + i * 60_000).toISOString())
    )
    cache.writePosts('c1', many)
    const file = cache.readPosts('c1')!
    expect(file.posts).toHaveLength(500)
    // newest is p599 (the latest creationTime)
    expect(file.posts[0].id).toBe('p599')
    // oldest kept is p100 (600 - 500)
    expect(file.posts[499].id).toBe('p100')
  })

  it('upsertPost adds a new post to an existing cached chat', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')])
    cache.upsertPost('c1', post('p2', 'c1', '2024-01-02T00:00:00Z'))
    const ids = cache.readPosts('c1')!.posts.map((p) => p.id)
    expect(ids).toEqual(['p2', 'p1'])
  })

  it('upsertPost is a no-op when the chat is not cached', () => {
    const cache = new CacheStore(dir)
    cache.upsertPost('c1', post('p1', 'c1', '2024-01-01T00:00:00Z'))
    expect(cache.readPosts('c1')).toBeNull()
  })

  it('patchPost replaces a post by id', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z', { text: 'orig' })])
    cache.patchPost('c1', post('p1', 'c1', '2024-01-01T00:00:00Z', { text: 'edited' }))
    expect(cache.readPosts('c1')!.posts[0].text).toBe('edited')
  })

  it('removePost drops a post by id', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [
      post('p1', 'c1', '2024-01-01T00:00:00Z'),
      post('p2', 'c1', '2024-01-02T00:00:00Z')
    ])
    cache.removePost('c1', 'p1')
    expect(cache.readPosts('c1')!.posts.map((p) => p.id)).toEqual(['p2'])
  })

  it('preserves nextPageToken on writePosts', () => {
    const cache = new CacheStore(dir)
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')], 'token-xyz')
    expect(cache.readPosts('c1')?.nextPageToken).toBe('token-xyz')
  })
})

describe('CacheStore robustness', () => {
  it('treats a corrupt posts file as a cache miss', () => {
    const cache = new CacheStore(dir)
    // Write a valid entry first so the message-cache/posts/ dir exists, then corrupt it.
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')])
    writeFileSync(join(dir, 'message-cache', 'posts', 'c1.json'), '{ not valid json', 'utf8')
    expect(cache.readPosts('c1')).toBeNull()
  })

  it('treats a corrupt index as a cache miss', () => {
    const cache = new CacheStore(dir)
    cache.writeMe(me)
    writeFileSync(join(dir, 'message-cache', 'index.json'), '{ not valid json', 'utf8')
    expect(cache.readIndex()).toBeNull()
  })

  it('sanitizes chatId into a safe filename (no path traversal)', () => {
    const cache = new CacheStore(dir)
    const nasty = '../../etc/passwd'
    cache.writePosts(nasty, [post('p1', nasty, '2024-01-01T00:00:00Z')])
    // The sanitized file lives under message-cache/posts/, nowhere else.
    expect(cache.readPosts(nasty)?.posts).toHaveLength(1)
  })

  it('clear() wipes the entire cache directory', () => {
    const cache = new CacheStore(dir)
    cache.writeMe(me)
    cache.writeChats(chats)
    cache.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')])
    cache.clear()
    expect(cache.readIndex()).toBeNull()
    expect(cache.readPosts('c1')).toBeNull()
  })

  it('is isolated per cwd', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'rc-cache-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'rc-cache-b-'))
    try {
      const a = new CacheStore(dirA)
      const b = new CacheStore(dirB)
      a.writePosts('c1', [post('p1', 'c1', '2024-01-01T00:00:00Z')])
      expect(b.readPosts('c1')).toBeNull()
      expect(a.readPosts('c1')?.posts).toHaveLength(1)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})
