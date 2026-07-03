/**
 * Renderer application state (zustand). Holds the auth state, the conversation
 * list, the active chat, its paginated messages, the known people map, and the
 * realtime-derived typing indicators.
 *
 * All IPC calls go through the injected `api` (real preload bridge or a fake
 * in tests), keeping the store pure and testable.
 */
import { create } from 'zustand'
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
  search: { query: string; results: GlipPost[]; loading: boolean } | null
  loadingChats: boolean
  error: string | null

  // actions
  init: (api: RcmApi) => Promise<void>
  doLogin: (api: RcmApi) => Promise<void>
  doLogout: (api: RcmApi) => Promise<void>
  selectChat: (api: RcmApi, chatId: string) => Promise<void>
  refreshChats: (api: RcmApi) => Promise<void>
  loadMoreMessages: (api: RcmApi) => Promise<void>
  sendText: (api: RcmApi, text: string) => Promise<void>
  setTyping: (api: RcmApi, chatId: string) => Promise<void>
  editMessage: (api: RcmApi, postId: string, text: string) => Promise<void>
  deleteMessage: (api: RcmApi, postId: string) => Promise<void>
  applyRealtime: (envelope: RealtimeEnvelope) => void
  applyTyping: (payload: TypingPayload) => void
  runSearch: (api: RcmApi, query: string) => Promise<void>
  setTheme: (api: RcmApi, theme: 'light' | 'dark' | 'system') => Promise<void>
  setError: (msg: string | null) => void
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
  search: null,
  loadingChats: false,
  error: null,

  async init(api) {
    try {
      const [config, auth] = await Promise.all([api.getConfig(), api.getAuthState()])
      set({ config: { ...config, theme: (config as { theme?: 'light' | 'dark' | 'system' }).theme } })
      if (auth.status === 'loggedIn') {
        const [me, chatsResp] = await Promise.all([api.getMe(), api.listChats()])
        const people = collectPeople(chatsResp.records)
        set({
          auth,
          me: me,
          chats: chatsResp.records,
          people
        })
      } else {
        set({ auth })
      }
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async doLogin(api) {
    set({ auth: { status: 'authenticating' }, error: null })
    try {
      const auth = await api.login()
      set({ auth })
      if (auth.status === 'loggedIn') {
        const [me, chatsResp] = await Promise.all([api.getMe(), api.listChats()])
        set({
          me,
          chats: chatsResp.records,
          people: collectPeople(chatsResp.records)
        })
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
        typing: {}
      })
    }
  },

  async selectChat(api, chatId) {
    set({ activeChatId: chatId })
    const existing = get().messages[chatId]
    if (existing && existing.posts.length > 0) {
      // already loaded; just mark read
      void api.markChatRead(chatId)
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
      void api.markChatRead(chatId)
      // clear unread badge for this chat
      set((state) => ({
        chats: state.chats.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c))
      }))
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  async refreshChats(api) {
    try {
      const resp = await api.listChats()
      set({ chats: resp.records, people: { ...get().people, ...collectPeople(resp.records) } })
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
        // If the chat isn't loaded yet, just bump its unread count + preview.
        if (!existing) {
          return {
            chats: state.chats.map((c) =>
              c.id === chatId
                ? {
                    ...c,
                    lastMessage: preview(post),
                    lastModifiedTime: post.creationTime,
                    unreadCount: state.activeChatId === chatId ? 0 : (c.unreadCount ?? 0) + 1
                  }
                : c
            )
          }
        }
        // Skip duplicates (optimistic post already present, or replay).
        if (existing.posts.some((p) => p.id === post.id)) return state
        return {
          ...appendPost(state, chatId, enrichOwn(post, state.me)),
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  lastMessage: preview(post),
                  lastModifiedTime: post.creationTime,
                  unreadCount: state.activeChatId === chatId ? 0 : (c.unreadCount ?? 0) + 1
                }
              : c
          )
        }
      })
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
