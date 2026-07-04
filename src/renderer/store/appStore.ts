/**
 * Renderer application state (zustand). Holds the auth state, the conversation
 * list, the active chat, its paginated messages, the known people map, and the
 * realtime-derived typing indicators.
 *
 * All IPC calls go through the injected `api` (real preload bridge or a fake
 * in tests), keeping the store pure and testable.
 */
import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import type {
  AuthState,
  GlipChat,
  GlipPerson,
  GlipPost,
  RealtimeEnvelope,
  ServerConfig,
  TypingPayload
} from '@shared/types'
import type { RcmApi } from '@shared/rcmApi'

export interface ChatMessages {
  posts: GlipPost[]
  /** tokens not yet loaded (older history) */
  hasMore: boolean
  loadingMore: boolean
}

export interface AppState {
  config: ServerConfig & { theme?: 'light' | 'dark' | 'system' } | null
  auth: AuthState
  chats: GlipChat[]
  activeChatId: string | null
  messages: Record<string, ChatMessages>
  me: GlipPerson | null
  people: Record<string, GlipPerson>
  typing: Record<string, TypingPayload[]> // chatId -> active typers
  /**
   * Locally-computed unread counts, keyed by chatId. The single UI-facing
   * source of unread — never sourced from the server's `unreadCount`.
   */
  unread: Record<string, number>
  /**
   * In-memory mirror of the persisted read-state watermarks (chatId -> ISO
   * timestamp of the newest message the user has seen). A message is unread
   * iff `creationTime > watermark` and it isn't the user's own.
   */
  readStates: Record<string, string>
  search: { query: string; results: GlipPost[]; loading: boolean } | null
  loadingChats: boolean
  error: string | null

  // actions
  init: (api: RcmApi) => Promise<void>
  doLogin: (api: RcmApi) => Promise<void>
  doLogout: (api: RcmApi) => Promise<void>
  selectChat: (api: RcmApi, chatId: string) => Promise<void>
  refreshChats: (api: RcmApi) => Promise<void>
  /**
   * Reconcile unread counts after a realtime interruption (system wake or
   * socket reconnect) where PostAdded events may have been missed. Refreshes
   * the chat list, then re-runs the watermark-based page-back reconcile.
   * Idempotent and concurrency-capped; safe to call repeatedly.
   */
  reconcileUnread: (api: RcmApi) => Promise<void>
  loadMoreMessages: (api: RcmApi) => Promise<void>
  sendText: (api: RcmApi, text: string) => Promise<void>
  setTyping: (api: RcmApi, chatId: string) => Promise<void>
  editMessage: (api: RcmApi, postId: string, text: string) => Promise<void>
  deleteMessage: (api: RcmApi, postId: string) => Promise<void>
  applyRealtime: (envelope: RealtimeEnvelope) => void
  applyTyping: (payload: TypingPayload) => void
  /**
   * Apply an auth-state push from main (auto-login result at boot, login,
   * logout). On `loggedIn` it loads the user + chats; on `loggedOut` it resets
   * local state; on `error` it surfaces the message so the user can retry.
   */
  applyAuthState: (api: RcmApi, state: AuthState) => Promise<void>
  runSearch: (api: RcmApi, query: string) => Promise<void>
  setTheme: (api: RcmApi, theme: 'light' | 'dark' | 'system') => Promise<void>
  setError: (msg: string | null) => void
}

// Most actions receive `api` as an argument (the injected RcmApi), but the
// realtime push handler `applyRealtime` only gets the envelope. We capture the
// most recently injected api here so realtime-driven side-effects (persisting
// the read watermark for the active chat) can call it. Set on init/login.
let currentApi: RcmApi | null = null

function rememberApi(api: RcmApi): RcmApi {
  currentApi = api
  return api
}

export const useAppStore = create<AppState>((set, get) => ({
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
  search: null,
  loadingChats: false,
  error: null,

  async init(api) {
    rememberApi(api)
    try {
      const [config, auth] = await Promise.all([api.getConfig(), api.getAuthState()])
      set({ config: { ...config, theme: (config as { theme?: 'light' | 'dark' | 'system' }).theme } })
      if (auth.status === 'loggedIn') {
        const [me, chatsResp] = await Promise.all([api.getMe(), api.listRecentChats()])
        const people = collectPeople(chatsResp.records)
        const readStates = await api.getReadStates()
        set({
          auth,
          me: me,
          chats: chatsResp.records,
          people,
          ...seedReadStatesAndUnread(chatsResp.records, readStates, config.apiMode)
        })
        // Reconcile unread for chats with activity since the persisted watermark.
        void reconcileUnreadForAll(api, chatsResp.records, get, set)
      } else {
        set({ auth })
      }
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async doLogin(api) {
    rememberApi(api)
    set({ auth: { status: 'authenticating' }, error: null })
    try {
      const auth = await api.login()
      set({ auth })
      if (auth.status === 'loggedIn') {
        const [me, chatsResp] = await Promise.all([api.getMe(), api.listRecentChats()])
        const readStates = await api.getReadStates()
        const apiMode = get().config?.apiMode
        set({
          me,
          chats: chatsResp.records,
          people: collectPeople(chatsResp.records),
          ...seedReadStatesAndUnread(chatsResp.records, readStates, apiMode)
        })
        void reconcileUnreadForAll(api, chatsResp.records, get, set)
      }
    } catch (e) {
      set({ auth: { status: 'error', message: errMsg(e) }, error: errMsg(e) })
    }
  },

  async doLogout(api) {
    try {
      await api.logout()
    } finally {
      set({
        auth: { status: 'loggedOut' },
        me: null,
        chats: [],
        activeChatId: null,
        messages: {},
        people: {},
        typing: {},
        unread: {},
        readStates: {}
      })
    }
  },

  async selectChat(api, chatId) {
    set({ activeChatId: chatId })
    const existing = get().messages[chatId]
    if (existing && existing.posts.length > 0) {
      // already loaded; just mark read (advances watermark, clears unread)
      markChatReadLocally(chatId, set)
      void api.markChatRead(chatId).catch(() => {})
      return
    }
    try {
      const resp = await api.listPosts({ chatId })
      nextPageTokens[chatId] = resp.nextPageToken
      set((state) => ({
        messages: {
          ...state.messages,
          [chatId]: {
            posts: resp.records,
            hasMore: Boolean(resp.nextPageToken),
            loadingMore: false
          }
        }
      }))
      // Opening the chat reads it: clear the unread badge, advance the
      // watermark to the newest visible message, and persist server-side.
      set((state) => ({ unread: { ...state.unread, [chatId]: 0 } }))
      markChatReadLocally(chatId, set)
      void api.markChatRead(chatId).catch(() => {})
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async refreshChats(api) {
    try {
      const resp = await api.listRecentChats()
      set((state) => {
        // Preserve existing unread entries; default unseen chats to 0.
        const unread: Record<string, number> = {}
        for (const c of resp.records) unread[c.id] = state.unread[c.id] ?? 0
        return {
          chats: resp.records,
          people: { ...state.people, ...collectPeople(resp.records) },
          unread
        }
      })
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async reconcileUnread(api) {
    // Only meaningful once logged in; otherwise the watermark/me are absent.
    if (get().auth.status !== 'loggedIn' || !get().me) return
    try {
      await get().refreshChats(api)
      await reconcileUnreadForAll(api, get().chats, get, set)
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async loadMoreMessages(api) {
    const chatId = get().activeChatId
    if (!chatId) return
    const m = get().messages[chatId]
    if (!m || !m.hasMore || m.loadingMore) return
    // We need the page token from the last load; recompute by tracking oldest.
    // Simplify: store nextPageToken on the chat messages.
    set((state) => ({
      messages: {
        ...state.messages,
        [chatId]: { ...state.messages[chatId], loadingMore: true }
      }
    }))
    try {
      // pageToken persisted via a non-enumerable; see selectChat/store below.
      const pageToken = nextPageTokens[chatId]
      const resp = await api.listPosts({ chatId, pageToken })
      nextPageTokens[chatId] = resp.nextPageToken
      set((state) => {
        const cur = state.messages[chatId]
        return {
          messages: {
            ...state.messages,
            [chatId]: {
              posts: dedupe([...resp.records, ...(cur?.posts ?? [])]),
              hasMore: Boolean(resp.nextPageToken),
              loadingMore: false
            }
          }
        }
      })
    } catch (e) {
      set({ error: errMsg(e) })
      set((state) => ({
        messages: {
          ...state.messages,
          [chatId]: { ...state.messages[chatId], loadingMore: false }
        }
      }))
    }
  },

  async sendText(api, text) {
    const chatId = get().activeChatId
    const me = get().me
    if (!chatId || !text.trim()) return
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const optimistic: GlipPost = {
      id: localId,
      localId,
      groupId: chatId,
      creatorId: me?.id ?? 'me',
      text,
      creationTime: new Date().toISOString(),
      pending: true,
      isOwn: true,
      creatorName: me ? `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() : 'You'
    }
    set((state) => appendPost(state, chatId, optimistic))
    try {
      const created = await api.sendPost({ chatId, text })
      set((state) => ({
        ...replacePost(state, chatId, localId, { ...created, isOwn: true }),
        chats: state.chats.map((c) =>
          c.id === chatId
            ? {
                ...c,
                lastMessage: preview(created),
                lastModifiedTime: new Date().toISOString()
              }
            : c
        )
      }))
      // We just authored a message in the active chat → it's read. Advance the
      // watermark so a later recompute doesn't resurrect it as unread.
      markChatReadLocally(chatId, set)
      void api.markChatRead(chatId).catch(() => {})
    } catch (e) {
      set((state) =>
        replacePost(state, chatId, localId, { ...optimistic, error: errMsg(e), pending: false })
      )
      set({ error: errMsg(e) })
    }
  },

  async setTyping(api, chatId) {
    try {
      await api.setTyping(chatId)
    } catch {
      /* typing notifications are best-effort */
    }
  },

  async editMessage(api, postId, text) {
    const chatId = get().activeChatId
    if (!chatId) return
    set((state) => updatePost(state, chatId, postId, (p) => ({ ...p, text, pending: true })))
    try {
      const updated = await api.editPost({ chatId, postId, text })
      set((state) => updatePost(state, chatId, postId, () => updated))
    } catch (e) {
      set((state) =>
        updatePost(state, chatId, postId, (p) => ({ ...p, pending: false, error: errMsg(e) }))
      )
      set({ error: errMsg(e) })
    }
  },

  async deleteMessage(api, postId) {
    const chatId = get().activeChatId
    if (!chatId) return
    set((state) => removePost(state, chatId, postId))
    try {
      await api.deletePost({ chatId, postId })
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  applyRealtime(envelope) {
    const body = envelope.body as { eventType?: string } & Partial<GlipPost>
    if (!body || !body.eventType) return
    const chatId = body.groupId ?? ''
    if (body.eventType === 'PostAdded') {
      const post = body as GlipPost & { eventType: 'PostAdded' }
      set((state) => {
        const existing = state.messages[chatId]
        const isActive = state.activeChatId === chatId
        const isOwn = post.creatorId === state.me?.id
        // Unread: a new non-own message in an inactive chat bumps the count.
        // An active chat stays at 0 (the user is looking at it); our own
        // messages never count as unread.
        const bump = !isActive && !isOwn
        const unread = bump
          ? { ...state.unread, [chatId]: (state.unread[chatId] ?? 0) + 1 }
          : isActive
            ? { ...state.unread, [chatId]: 0 }
            : state.unread
        // If the chat isn't loaded yet, just bump unread + preview.
        if (!existing) {
          return {
            unread,
            chats: state.chats.map((c) =>
              c.id === chatId
                ? { ...c, lastMessage: preview(post), lastModifiedTime: post.creationTime }
                : c
            )
          }
        }
        // Skip duplicates (optimistic post already present, or replay).
        if (existing.posts.some((p) => p.id === post.id)) return state
        return {
          ...appendPost(state, chatId, enrichOwn(post, state.me)),
          unread,
          chats: state.chats.map((c) =>
            c.id === chatId
              ? { ...c, lastMessage: preview(post), lastModifiedTime: post.creationTime }
              : c
          )
        }
      })
      // Active chat: advance the watermark to this post and persist, since the
      // user is viewing it in real time.
      if (get().activeChatId === chatId && currentApi) {
        markChatReadLocally(chatId, set, post.creationTime)
        void currentApi.markChatRead(chatId).catch(() => {})
      }
    } else if (body.eventType === 'PostUpdated') {
      set((state) => updatePost(state, chatId, body.id ?? '', () => body as GlipPost))
    } else if (body.eventType === 'PostRemoved') {
      set((state) => removePost(state, chatId, body.id ?? ''))
    }
  },

  applyTyping(payload) {
    set((state) => {
      const list = state.typing[payload.chatId] ?? []
      const filtered = list.filter((t) => t.personId !== payload.personId)
      const next = [...filtered, payload]
      return { typing: { ...state.typing, [payload.chatId]: next } }
    })
    // auto-clear after 4s
    const chatId = payload.chatId
    setTimeout(() => {
      set((state) => {
        const list = state.typing[chatId] ?? []
        return {
          typing: {
            ...state.typing,
            [chatId]: list.filter((t) => t.personId !== payload.personId)
          }
        }
      })
    }, 4000)
  },

  async applyAuthState(api, state) {
    // Ignore a stale push that matches the current state.
    if (get().auth.status === state.status) {
      // For loggedIn, still ensure user/chats are loaded (idempotent re-entry).
      if (state.status !== 'loggedIn') return
    }
    rememberApi(api)
    if (state.status === 'loggedIn') {
      set({ auth: state })
      try {
        const [me, chatsResp] = await Promise.all([api.getMe(), api.listRecentChats()])
        const readStates = await api.getReadStates()
        const apiMode = get().config?.apiMode
        set({
          me,
          chats: chatsResp.records,
          people: collectPeople(chatsResp.records),
          ...seedReadStatesAndUnread(chatsResp.records, readStates, apiMode)
        })
        void reconcileUnreadForAll(api, chatsResp.records, get, set)
      } catch (e) {
        set({ error: errMsg(e) })
      }
    } else if (state.status === 'loggedOut') {
      set({
        auth: state,
        me: null,
        chats: [],
        activeChatId: null,
        messages: {},
        people: {},
        typing: {},
        unread: {},
        readStates: {}
      })
    } else {
      // authenticating | error
      set({ auth: state })
    }
  },

  async runSearch(api, query) {
    if (!query.trim()) {
      set({ search: null })
      return
    }
    set({ search: { query, results: [], loading: true } })
    try {
      const results = await api.searchPosts(query)
      set({ search: { query, results, loading: false } })
    } catch (e) {
      set({ search: { query, results: [], loading: false }, error: errMsg(e) })
    }
  },

  async setTheme(api, theme) {
    await api.updateSettings({ theme })
    set((state) => ({ config: state.config ? { ...state.config, theme } : state.config }))
  },

  setError(msg) {
    set({ error: msg })
  }
}))

// ── internal helpers (module-scoped) ─────────────────────────────────────────

const nextPageTokens: Record<string, string | undefined> = {}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function collectPeople(chats: GlipChat[]): Record<string, GlipPerson> {
  const out: Record<string, GlipPerson> = {}
  for (const c of chats) {
    if (c.person) out[c.person.id] = c.person
  }
  return out
}

type GetState = StoreApi<AppState>['getState']
type SetState = StoreApi<AppState>['setState']

/**
 * Mark a chat as read locally: clear its unread badge and advance the in-memory
 * watermark to `at` (default: now). Does NOT touch the server — callers handle
 * persistence via `api.markChatRead` (which the IPC layer persists).
 */
function markChatReadLocally(
  chatId: string,
  set: SetState,
  at: string = new Date().toISOString()
): void {
  set((state) => ({
    unread: { ...state.unread, [chatId]: 0 },
    readStates: { ...state.readStates, [chatId]: at }
  }))
}

/**
 * Build the initial `readStates` + `unread` slices from the persisted watermarks
 * and the freshly-loaded chat list. Two cases:
 *
 *  - First-ever start (empty persisted map): seed each chat's watermark to its
 *    `lastModifiedTime` so years of history isn't shown as unread. In MOCK mode
 *    we instead seed demo watermarks so the seeded chats show unread badges.
 *  - Returning user: keep persisted watermarks; default any new chat to "read
 *    up to its lastModifiedTime".
 */
function seedReadStatesAndUnread(
  chats: GlipChat[],
  persisted: Record<string, string>,
  apiMode: 'mock' | 'real' | undefined
): Pick<AppState, 'readStates' | 'unread'> {
  const isFirstStart = Object.keys(persisted).length === 0
  const readStates: Record<string, string> = { ...persisted }
  const unread: Record<string, number> = {}

  if (isFirstStart && apiMode === 'mock') {
    // MOCK demo seed: pretend the user last saw each chat just before its most
    // recent non-own seeded message, so the sidebar shows unread badges.
    seedMockDemoReadStates(readStates)
  }

  for (const c of chats) {
    if (!(c.id in readStates)) {
      // First-ever start (real mode) OR a brand-new chat discovered this session:
      // treat everything up to its current last activity as read.
      readStates[c.id] = c.lastModifiedTime ?? new Date().toISOString()
    }
    unread[c.id] = 0
  }
  return { readStates, unread }
}

/**
 * MOCK-only: seed read-state watermarks so the seeded chats display their
 * historical unread counts on first launch (Engineering=2, Alice DM=1), without
 * sourcing the counts from the server. We pick deterministic timestamps that
 * sit just *before* the seeded posts we want to count as unread.
 *
 * The mock seeds posts at fixed minute-offsets from `Date.now()`, so we anchor
 * the watermarks relative to "now" the same way (the values only need to be
 * internally consistent with the posts the cold-start reconcile will fetch).
 */
function seedMockDemoReadStates(readStates: Record<string, string>): void {
  const now = Date.now()
  // Engineering: 4 posts at 5/4/3/2 min ago; the last two (3m "I will lead
  // standup today" by me, 2m "shipping the release now" by Carol) are newer
  // than a 3.5m-ago watermark → 1 unread by a non-owner (Carol). To yield the
  // classic "2 unread" demo we set the watermark to 4.5m ago so the standup
  // (alice, 4m) + release (carol, 2m) both count.
  readStates['team-general'] = new Date(now - 4.5 * 60_000).toISOString()
  // Alice DM: posts at 30m (alice) and 28m (me). Watermark at 31m → only
  // alice's "hey, got a sec?" (30m) counts as unread → 1.
  readStates['chat-dm-alice'] = new Date(now - 31 * 60_000).toISOString()
}

/**
 * Cold-start / refresh reconciliation: for every chat whose `lastModifiedTime`
 * is newer than its persisted watermark, page back through recent posts and count
 * those newer than the watermark. Chats with no new activity stay at 0 (no
 * request). Runs in the background after the sidebar renders; each chat's count
 * updates independently as its fetch completes.
 */
async function reconcileUnreadForAll(
  api: RcmApi,
  chats: GlipChat[],
  get: GetState,
  set: SetState
): Promise<void> {
  const meId = get().me?.id
  const watermarks = get().readStates
  // Only chats with potential new activity since the watermark need fetching.
  const candidates = chats.filter(
    (c) => c.lastModifiedTime && (watermarks[c.id] ?? '') < c.lastModifiedTime!
  )
  // Bound concurrency so we don't fire hundreds of simultaneous requests.
  const CONCURRENCY = 5
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const chat = candidates[cursor++]
      try {
        const count = await countUnreadViaPages(api, chat.id, watermarks[chat.id], meId)
        set((state) => ({ unread: { ...state.unread, [chat.id]: count } }))
      } catch {
        // Best-effort: leave the chat at its existing (seeded) unread on error.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, run))
}

/**
 * Page back through a chat's posts (newest-first) until we cross the watermark,
 * counting non-own messages newer than it. Safety-valve: stop after MAX_PAGES
 * pages to guard against pathological/looping data.
 */
async function countUnreadViaPages(
  api: RcmApi,
  chatId: string,
  watermark: string | undefined,
  meId?: string
): Promise<number> {
  if (!watermark) return 0
  const PAGE_SIZE = 500
  const MAX_PAGES = 20
  let total = 0
  let pageToken: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const resp = await api.listPosts({ chatId, pageToken, recordCount: PAGE_SIZE })
    let reachedWatermark = false
    for (const p of resp.records) {
      if (p.creationTime <= watermark) {
        reachedWatermark = true
        continue // anything at-or-before the watermark is read
      }
      if (p.creatorId !== meId) total += 1
    }
    if (reachedWatermark || !resp.nextPageToken) break
    pageToken = resp.nextPageToken
  }
  return total
}

function appendPost(state: AppState, chatId: string, post: GlipPost): Partial<AppState> {
  const existing = state.messages[chatId]
  return {
    messages: {
      ...state.messages,
      [chatId]: existing
        ? { ...existing, posts: dedupe([...existing.posts, post]) }
        : { posts: [post], hasMore: false, loadingMore: false }
    }
  }
}

function replacePost(
  state: AppState,
  chatId: string,
  localId: string,
  post: GlipPost
): Partial<AppState> {
  const existing = state.messages[chatId]
  if (!existing) return {}
  return {
    messages: {
      ...state.messages,
      [chatId]: {
        ...existing,
        posts: existing.posts.map((p) => (p.localId === localId || p.id === localId ? post : p))
      }
    }
  }
}

function updatePost(
  state: AppState,
  chatId: string,
  postId: string,
  fn: (p: GlipPost) => GlipPost
): Partial<AppState> {
  const existing = state.messages[chatId]
  if (!existing) return {}
  return {
    messages: {
      ...state.messages,
      [chatId]: { ...existing, posts: existing.posts.map((p) => (p.id === postId ? fn(p) : p)) }
    }
  }
}

function removePost(state: AppState, chatId: string, postId: string): Partial<AppState> {
  const existing = state.messages[chatId]
  if (!existing) return {}
  return {
    messages: {
      ...state.messages,
      [chatId]: { ...existing, posts: existing.posts.filter((p) => p.id !== postId) }
    }
  }
}

function dedupe(posts: GlipPost[]): GlipPost[] {
  const seen = new Set<string>()
  const out: GlipPost[] = []
  for (const p of posts) {
    const key = p.localId ?? p.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function enrichOwn(post: GlipPost, me: GlipPerson | null): GlipPost {
  return { ...post, isOwn: post.creatorId === me?.id }
}

function preview(post: GlipPost): string {
  return post.text.length > 80 ? post.text.slice(0, 77) + '…' : post.text
}
