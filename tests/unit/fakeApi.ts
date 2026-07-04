import type { RcmApi } from '../../src/shared/rcmApi'
import type {
  AuthState,
  GlipAttachment,
  GlipChat,
  GlipMention,
  GlipPerson,
  GlipPost,
  GlipTeam,
  PageResult,
  RealtimeEnvelope,
  ServerConfig,
  TypingPayload
} from '../../src/shared/types'

/**
 * A fake of the preload `rcm` API backed by a MockMessagingClient. Records all
 * calls so renderer/store tests can assert behavior. Push subscriptions are
 * wired so the test can `emit()` events to simulate realtime.
 */
export function createFakeApi(opts: {
  chats: GlipChat[]
  me: GlipPerson
  posts?: Record<string, GlipPost[]>
  /** Injected read-state watermarks (chatId -> ISO). Defaults to empty. */
  readStates?: Record<string, string>
}): RcmApi & {
  emit: (env: RealtimeEnvelope) => void
  emitTyping: (p: TypingPayload) => void
  calls: Record<string, unknown[][]>
} {
  const calls: Record<string, unknown[][]> = {}

  const record = (name: string, args: unknown[]) => {
    calls[name] ??= []
    calls[name].push(args)
  }

  const postsByChat: Record<string, GlipPost[]> = { ...(opts.posts ?? {}) }
  let idCounter = 1
  const nextId = (p: string) => `${p}-${Date.now()}-${idCounter++}`

  const realtimeCbs = new Set<(env: RealtimeEnvelope) => void>()
  const typingCbs = new Set<(p: TypingPayload) => void>()
  const reconcileCbs = new Set<() => void>()
  const authCbs = new Set<(s: AuthState) => void>()

  const api = {
    getConfig: async (): Promise<ServerConfig & { theme: 'light' | 'dark' | 'system' }> => {
      record('getConfig', [])
      return {
        server: 'sandbox',
        apiMode: 'mock',
        theme: 'dark'
      }
    },
    login: async (): Promise<AuthState> => {
      record('login', [])
      const state: AuthState = { status: 'loggedIn', me: opts.me }
      for (const cb of authCbs) cb(state)
      return state
    },
    loginWithToken: async () => api.login(),
    logout: async (): Promise<AuthState> => {
      record('logout', [])
      const state: AuthState = { status: 'loggedOut' }
      for (const cb of authCbs) cb(state)
      return state
    },
    getAuthState: async (): Promise<AuthState> => ({ status: 'loggedOut' }),
    getMe: async (): Promise<GlipPerson> => {
      record('getMe', [])
      return opts.me
    },
    getReadStates: async (): Promise<Record<string, string>> => {
      record('getReadStates', [])
      return { ...(opts.readStates ?? {}) }
    },
    listRecentChats: async (): Promise<PageResult<GlipChat>> => {
      record('listRecentChats', [])
      return { records: opts.chats }
    },
    listTeams: async (): Promise<GlipTeam[]> => {
      record('listTeams', [])
      return []
    },
    getTeam: async (chatId: string): Promise<GlipTeam> => {
      record('getTeam', [chatId])
      return { id: chatId, type: 'Team', name: 'Team' }
    },
    createTeam: async (args: { name: string }): Promise<GlipTeam> => {
      record('createTeam', [args])
      return { id: nextId('team'), type: 'Team', name: args.name }
    },
    listPosts: async (args: {
      chatId: string
      pageToken?: string
      recordCount?: number
    }): Promise<PageResult<GlipPost>> => {
      record('listPosts', [args])
      const all = (postsByChat[args.chatId] ?? []).slice().reverse()
      const size = args.recordCount ?? 50
      const start = args.pageToken ? Number(args.pageToken) : 0
      const slice = all.slice(start, start + size)
      const nextStart = start + slice.length
      return {
        records: slice,
        nextPageToken: nextStart < all.length ? String(nextStart) : undefined
      }
    },
    sendPost: async (args: {
      chatId: string
      text: string
      mentions?: GlipMention[]
      attachments?: GlipAttachment[]
    }): Promise<GlipPost> => {
      record('sendPost', [args])
      const post: GlipPost = {
        id: nextId('post'),
        groupId: args.chatId,
        creatorId: opts.me.id,
        text: args.text,
        creationTime: new Date().toISOString(),
        mentions: args.mentions,
        attachments: args.attachments
      }
      postsByChat[args.chatId] = [...(postsByChat[args.chatId] ?? []), post]
      return post
    },
    editPost: async (args: { chatId: string; postId: string; text: string }): Promise<GlipPost> => {
      record('editPost', [args])
      const list = postsByChat[args.chatId] ?? []
      const idx = list.findIndex((p) => p.id === args.postId)
      const updated = { ...list[idx], text: args.text }
      if (idx >= 0) list[idx] = updated
      return updated
    },
    deletePost: async (args: { chatId: string; postId: string }): Promise<void> => {
      record('deletePost', [args])
      postsByChat[args.chatId] = (postsByChat[args.chatId] ?? []).filter(
        (p) => p.id !== args.postId
      )
    },
    uploadFile: async (args: {
      chatId: string
      name: string
      type: string
      data: number[]
    }): Promise<GlipAttachment> => {
      record('uploadFile', [args])
      return { type: 'File', id: nextId('file'), name: args.name }
    },
    searchPosts: async (text: string): Promise<GlipPost[]> => {
      record('searchPosts', [text])
      return []
    },
    markChatRead: async (chatId: string): Promise<void> => {
      record('markChatRead', [chatId])
    },
    setTyping: async (chatId: string): Promise<void> => {
      record('setTyping', [chatId])
    },
    openExternal: async (url: string): Promise<boolean> => {
      record('openExternal', [url])
      return true
    },
    updateSettings: async (patch: { theme: 'light' | 'dark' | 'system' }): Promise<unknown> => {
      record('updateSettings', [patch])
      return patch
    },
    onAuthStateChanged: (cb: (s: AuthState) => void): (() => void) => {
      authCbs.add(cb)
      return () => authCbs.delete(cb)
    },
    onRealtimeEvent: (cb: (env: RealtimeEnvelope) => void): (() => void) => {
      realtimeCbs.add(cb)
      return () => realtimeCbs.delete(cb)
    },
    onRealtimeReconciled: (cb: () => void): (() => void) => {
      reconcileCbs.add(cb)
      return () => reconcileCbs.delete(cb)
    },
    onTypingEvent: (cb: (p: TypingPayload) => void): (() => void) => {
      typingCbs.add(cb)
      return () => typingCbs.delete(cb)
    }
  } as unknown as RcmApi

  return {
    ...api,
    emit: (env: RealtimeEnvelope) => {
      for (const cb of realtimeCbs) cb(env)
    },
    emitTyping: (p: TypingPayload) => {
      for (const cb of typingCbs) cb(p)
    },
    calls,
    // expose for the store's pending-message assertions
    _postsByChat: postsByChat
  } as unknown as RcmApi & {
    emit: (env: RealtimeEnvelope) => void
    emitTyping: (p: TypingPayload) => void
    calls: Record<string, unknown[][]>
  }
}
