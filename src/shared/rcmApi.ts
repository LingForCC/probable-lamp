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
  listChats: () => Promise<PageResult<GlipChat>>
  listTeams: () => Promise<GlipTeam[]>
  getTeam: (chatId: string) => Promise<GlipTeam>
  createTeam: (args: { name: string; members?: string[]; description?: string }) => Promise<GlipTeam>
  listPosts: (args: {
    chatId: string
    pageToken?: string
    recordCount?: number
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
  searchPosts: (text: string) => Promise<GlipPost[]>
  markChatRead: (chatId: string) => Promise<void>
  setTyping: (chatId: string) => Promise<void>
  openExternal: (url: string) => Promise<boolean>
  updateSettings: (patch: { theme: 'light' | 'dark' | 'system' }) => Promise<unknown>

  onAuthStateChanged: (cb: (state: AuthState) => void) => () => void
  onRealtimeEvent: (cb: (env: RealtimeEnvelope) => void) => () => void
  onTypingEvent: (cb: (p: TypingPayload) => void) => () => void
}
