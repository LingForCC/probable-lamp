/**
 * The shape of the IPC bridge exposed to the renderer (`window.rcm`).
 *
 * Defined in `shared/` (not preload/) so the renderer store and tests can import
 * the type without pulling in the preload module (which imports `electron`).
 */
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
} from './types.js'

export interface RcmApi {
  getConfig: () => Promise<ServerConfig & { theme: 'light' | 'dark' | 'system' }>
  login: () => Promise<AuthState>
  loginWithToken: () => Promise<AuthState>
  logout: () => Promise<AuthState>
  getAuthState: () => Promise<AuthState>
  getMe: () => Promise<GlipPerson>
  /**
   * Persisted per-chat read-state watermarks (chatId -> ISO timestamp of the
   * newest message the user has seen). Used by the renderer to compute unread
   * counts locally without trusting the server's `unreadCount`.
   */
  getReadStates: () => Promise<Record<string, string>>
  /**
   * ISO timestamp of the first time the app launched with an empty read-state
   * map. Used as the seed watermark on first start so a chat is unread only if
   * it has activity newer than when the user first opened the app. Null until
   * the first start is recorded at boot.
   */
  getFirstStartedAt: () => Promise<string | null>
  /**
   * Cached current user from disk (null if the cache is empty/cold). Used to
   * render the sidebar instantly on cold start before the network resolves.
   */
  getCachedMe: () => Promise<GlipPerson | null>
  /**
   * Cached chat list from disk (empty if cold). Rendered instantly on cold
   * start; the network refresh that follows overwrites it.
   */
  getCachedChats: () => Promise<GlipChat[]>
  /**
   * Cached posts for a chat (empty if cold). Returned in newest-first order,
   * capped at 500. Rendered instantly on chat open; a background network
   * refresh merges in any newer posts.
   */
  getCachedPosts: (chatId: string) => Promise<{ posts: GlipPost[]; nextPageToken?: string }>
  listRecentChats: () => Promise<PageResult<GlipChat>>
  listTeams: () => Promise<GlipTeam[]>
  getTeam: (chatId: string) => Promise<GlipTeam>
  createTeam: (args: { name: string; members?: string[]; description?: string }) => Promise<GlipTeam>
  listPosts: (args: {
    chatId: string
    pageToken?: string
    recordCount?: number
    /**
     * When false, the fetched page is NOT written to the offline cache. Used
     * by the unread reconcile (which pages through history for counting only)
     * so counting never churns the disk. Defaults to true (write-through).
     */
    cache?: boolean
  }) => Promise<PageResult<GlipPost>>
  sendPost: (args: {
    chatId: string
    text: string
    mentions?: GlipMention[]
    attachments?: GlipAttachment[]
  }) => Promise<GlipPost>
  editPost: (args: { chatId: string; postId: string; text: string }) => Promise<GlipPost>
  deletePost: (args: { chatId: string; postId: string }) => Promise<void>
  uploadFile: (args: {
    chatId: string
    name: string
    type: string
    data: number[]
  }) => Promise<GlipAttachment>
  markChatRead: (chatId: string) => Promise<void>
  setTyping: (chatId: string) => Promise<void>
  openExternal: (url: string) => Promise<boolean>
  updateSettings: (patch: { theme: 'light' | 'dark' | 'system' }) => Promise<unknown>

  onAuthStateChanged: (cb: (state: AuthState) => void) => () => void
  onRealtimeEvent: (cb: (env: RealtimeEnvelope) => void) => () => void
  /**
   * Fired when the realtime socket has reconnected after a drop (or the system
   * resumed from sleep), meaning realtime events may have been missed and the
   * renderer should re-run its unread reconciliation from the watermark.
   */
  onRealtimeReconciled: (cb: () => void) => () => void
  onTypingEvent: (cb: (p: TypingPayload) => void) => () => void
}
