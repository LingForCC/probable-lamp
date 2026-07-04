/**
 * Offline history cache: per-chat JSON files under `<userData>/message-cache/`.
 *
 * Stores the most recent N posts per chat (default 500) and the chat list +
 * current user, so the app can render instantly on cold start and show recent
 * history while offline. Write-through happens in the IPC layer on every fetch
 * and realtime event; the renderer reads from cache before hitting the network.
 *
 * Plaintext — same trust boundary as the persisted read-state watermarks
 * (`AppStore.readStates`) and the chat previews already shown in the sidebar.
 * A future option is to encrypt at rest with `safeStorage`.
 *
 * The reconcile/unread logic (`countUnreadViaPages`, `reconcileUnreadForAll`)
 * never writes to this cache — it passes `cache: false` to `listPosts` — so the
 * watermark-based unread computation stays the sole source of truth for `unread`.
 *
 * The directory is named `message-cache` (not `cache`) to avoid colliding with
 * Chromium's reserved `<userData>/Cache/` directory on case-insensitive
 * filesystems (macOS APFS/HFS+ default), where `cache` and `Cache` resolve to
 * the same path and hold Chromium's HTTP cache (`Cache_Data`).
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GlipChat, GlipPerson, GlipPost } from '../shared/types.js'

export interface CachedChatFile {
  posts: GlipPost[]
  /** Server cursor for the page older than the oldest cached post. */
  nextPageToken?: string
  updatedAt: string
}

export interface CachedIndex {
  me: GlipPerson | null
  chats: GlipChat[]
  updatedAt: string
}

const MAX_POSTS_PER_CHAT = 500

export class CacheStore {
  private readonly cacheDir: string
  private readonly postsDir: string

  /**
   * @param cwd Optional parent directory for the cache. Production leaves it
   * unset (Electron's default userData dir); tests inject a temp dir.
   */
  constructor(cwd?: string) {
    const parent = cwd ?? app.getPath('userData')
    this.cacheDir = join(parent, 'message-cache')
    this.postsDir = join(this.cacheDir, 'posts')
  }

  // ── index (me + chats) ───────────────────────────────────────────────

  readIndex(): CachedIndex | null {
    return this.readJson<CachedIndex>(join(this.cacheDir, 'index.json'))
  }

  writeMe(me: GlipPerson): void {
    const idx = this.readIndex() ?? emptyIndex()
    this.writeJson(join(this.cacheDir, 'index.json'), { ...idx, me, updatedAt: now() })
  }

  writeChats(chats: GlipChat[]): void {
    const idx = this.readIndex() ?? emptyIndex()
    this.writeJson(join(this.cacheDir, 'index.json'), { ...idx, chats, updatedAt: now() })
  }

  // ── per-chat posts ───────────────────────────────────────────────────

  readPosts(chatId: string): CachedChatFile | null {
    return this.readJson<CachedChatFile>(this.postsPath(chatId))
  }

  /**
   * Merge a fetched page into the cache: dedupe by `localId ?? id`, sort
   * newest-first (lexicographic ISO-8601, matching the watermark compare used
   * by reconcile), and cap to `MAX_POSTS_PER_CHAT`.
   */
  writePosts(chatId: string, incoming: GlipPost[], nextPageToken?: string): void {
    const existing = this.readPosts(chatId)
    const posts = mergeAndCap(existing?.posts ?? [], incoming)
    this.writeJson(this.postsPath(chatId), { posts, nextPageToken, updatedAt: now() })
  }

  /** Add or replace a single post (realtime PostAdded / sendPost). No-op if the chat isn't cached. */
  upsertPost(chatId: string, post: GlipPost): void {
    const existing = this.readPosts(chatId)
    if (!existing) return
    const posts = mergeAndCap(existing.posts, [post])
    this.writeJson(this.postsPath(chatId), { ...existing, posts, updatedAt: now() })
  }

  /** Replace a post by id (realtime PostUpdated / editPost). No-op if not cached. */
  patchPost(chatId: string, post: GlipPost): void {
    const existing = this.readPosts(chatId)
    if (!existing) return
    const posts = existing.posts.map((p) => (p.id === post.id ? { ...p, ...post } : p))
    this.writeJson(this.postsPath(chatId), { ...existing, posts, updatedAt: now() })
  }

  /** Remove a post by id (realtime PostRemoved / deletePost). No-op if not cached. */
  removePost(chatId: string, postId: string): void {
    const existing = this.readPosts(chatId)
    if (!existing) return
    const posts = existing.posts.filter((p) => p.id !== postId)
    this.writeJson(this.postsPath(chatId), { ...existing, posts, updatedAt: now() })
  }

  /** Wipe the entire cache (logout). */
  clear(): void {
    rmSync(this.cacheDir, { recursive: true, force: true })
  }

  // ── internals ────────────────────────────────────────────────────────

  private postsPath(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.postsDir, `${safe}.json`)
  }

  private readJson<T>(filePath: string): T | null {
    try {
      const raw = readFileSync(filePath, 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(data), 'utf8')
    } catch {
      // best-effort: cache write failures are non-fatal
    }
  }
}

// ── module-scoped helpers ─────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

function emptyIndex(): CachedIndex {
  return { me: null, chats: [], updatedAt: '' }
}

function dedupeKey(post: GlipPost): string {
  return post.localId ?? post.id
}

/**
 * Merge cached + incoming posts, dedupe by `localId ?? id`, sort newest-first,
 * and cap to `MAX_POSTS_PER_CHAT`. Incoming posts win ties (listed first) so
 * fresher data from the network replaces stale cached copies.
 */
function mergeAndCap(existing: GlipPost[], incoming: GlipPost[]): GlipPost[] {
  const seen = new Set<string>()
  const out: GlipPost[] = []
  for (const p of [...incoming, ...existing]) {
    const key = dedupeKey(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  out.sort((a, b) =>
    b.creationTime > a.creationTime ? 1 : b.creationTime < a.creationTime ? -1 : 0
  )
  return out.slice(0, MAX_POSTS_PER_CHAT)
}
