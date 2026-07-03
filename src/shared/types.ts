/**
 * Shared types and constants used by main, preload, and renderer.
 *
 * This module must be importable from Node (main/preload) and browser
 * (renderer) contexts, so it must not import any node-only or dom-only APIs.
 */

// ─── Glip data model ──────────────────────────────────────────────────────────

export type ChatType = 'Personal' | 'Group' | 'Team' | 'Direct' | 'Everyone'

export interface GlipPerson {
  id: string
  firstName?: string
  lastName?: string
  email?: string
  avatar?: string
  status?: string
  /** presence info, when available */
  presence?: {
    presenceStatus?: 'Available' | 'Busy' | 'Offline' | 'Unavailable'
    telephonyStatus?: string
  }
}

export interface GlipChat {
  id: string
  type: ChatType
  name?: string
  description?: string
  /** last (most recent) message snippet */
  lastMessage?: string
  lastModifiedTime?: string
  /** number of members */
  membersCount?: number
  /** unread message count */
  unreadCount?: number
  /** avatar / icon URL */
  avatar?: string
  /** for direct chats, the other person */
  person?: GlipPerson
}

export interface GlipTeam extends GlipChat {
  type: 'Team'
  teamMembers?: GlipPerson[]
}

export type PostType =
  | 'TextMessage'
  | 'Cards'
  | 'People'
  | 'Events'
  | 'Files'
  | 'Note'
  | 'Task'

export type PostStatus = 'Active' | 'Deleted'

export interface GlipMention {
  type?: 'Person' | 'Team' | 'File' | 'All'
  id?: string
  name?: string
}

export interface GlipAttachment {
  type?: 'Card' | 'File' | 'Event' | 'Note' | 'Task'
  id?: string
  name?: string
  title?: string
  text?: string
  contentUri?: string
  /** For adaptive cards: nested blocks */
  fields?: Array<{ title: string; value: string; style?: string }>
  color?: string
}

export interface GlipPost {
  id: string
  groupId: string
  type?: PostType
  creatorId: string
  text: string
  creationTime: string
  lastModifiedTime?: string
  attachments?: GlipAttachment[]
  mentions?: GlipMention[]
  status?: PostStatus
  /** True when this post is created by the current user (resolved client-side) */
  isOwn?: boolean
  /** Display name of creator, resolved client-side */
  creatorName?: string
  /** Avatar of creator, resolved client-side */
  creatorAvatar?: string
  /** Optimistic local id, set before server confirms */
  localId?: string
  pending?: boolean
  /** Set when optimistic send failed */
  error?: string
}

export interface PageResult<T> {
  records: T[]
  nextPageToken?: string
  prevPageToken?: string
}

// ─── Realtime events ──────────────────────────────────────────────────────────

export type PostEventType = 'PostAdded' | 'PostUpdated' | 'PostRemoved'

export interface PostEventBody extends GlipPost {
  eventType: PostEventType
}

export interface RealtimeEnvelope {
  uuid?: string
  event: string
  timestamp?: string
  subscriptionId?: string
  body: PostEventBody | Record<string, unknown>
}

// ─── Auth / tokens ────────────────────────────────────────────────────────────

export interface TokenSet {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  refresh_token_expires_in: number
  scope?: string
  owner_id?: string
  endpoint_id?: string
  /** epoch ms when access_token was stored (for expiry calc) */
  obtainedAt: number
}

export interface ServerConfig {
  server: 'sandbox' | 'production'
  apiMode: 'mock' | 'real'
  clientId?: string
  redirectUri?: string
}

// ─── IPC contract ─────────────────────────────────────────────────────────────

/**
 * Strongly-typed channel names. Using a single source of truth keeps the
 * preload bridge and main handlers in sync.
 */
export const IPC = {
  // Renderer -> Main
  GET_CONFIG: 'app:get-config',
  LOGIN: 'auth:login',
  LOGIN_WITH_TOKEN: 'auth:login-with-token', // mock-mode shortcut
  LOGOUT: 'auth:logout',
  GET_AUTH_STATE: 'auth:get-state',
  GET_ME: 'rc:get-me',
  LIST_CHATS: 'rc:list-chats',
  LIST_TEAMS: 'rc:list-teams',
  CREATE_TEAM: 'rc:create-team',
  GET_TEAM: 'rc:get-team',
  LIST_POSTS: 'rc:list-posts',
  SEND_POST: 'rc:send-post',
  EDIT_POST: 'rc:edit-post',
  DELETE_POST: 'rc:delete-post',
  UPLOAD_FILE: 'rc:upload-file',
  SEARCH_POSTS: 'rc:search-posts',
  MARK_CHAT_READ: 'rc:mark-chat-read',
  SET_TYPING: 'rc:set-typing',
  OPEN_EXTERNAL: 'shell:open-external',
  UPDATE_SETTINGS: 'app:update-settings',

  // Main -> Renderer (push)
  AUTH_STATE_CHANGED: 'push:auth-state',
  REALTIME_EVENT: 'push:realtime-event',
  TYPING_EVENT: 'push:typing-event'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export type AuthState =
  | { status: 'loggedOut' }
  | { status: 'authenticating' }
  | { status: 'loggedIn'; me: GlipPerson }
  | { status: 'error'; message: string }

export interface TypingPayload {
  chatId: string
  personId: string
  personName: string
}

// ─── Client interface ─────────────────────────────────────────────────────────

/**
 * The common interface implemented by both the real RingCentral REST client and
 * the in-memory mock client. The Electron main process holds a single instance
 * and forwards IPC calls to it.
 */
export interface IMessagingClient {
  readonly isMock: boolean

  setTokens(tokens: TokenSet | null): void
  getTokens(): TokenSet | null

  getMe(): Promise<GlipPerson>
  listChats(): Promise<PageResult<GlipChat>>
  listTeams(): Promise<GlipTeam[]>
  getTeam(chatId: string): Promise<GlipTeam>
  createTeam(name: string, members?: string[], description?: string): Promise<GlipTeam>
  listPosts(
    chatId: string,
    opts?: { pageToken?: string; recordCount?: number }
  ): Promise<PageResult<GlipPost>>
  sendPost(
    chatId: string,
    text: string,
    opts?: { mentions?: GlipMention[]; attachments?: GlipAttachment[] }
  ): Promise<GlipPost>
  editPost(chatId: string, postId: string, text: string): Promise<GlipPost>
  deletePost(chatId: string, postId: string): Promise<void>
  uploadFile(chatId: string, file: { name: string; type: string; data: Uint8Array }): Promise<GlipAttachment>
  searchPosts(text: string): Promise<GlipPost[]>
  markChatRead(chatId: string): Promise<void>
  setTyping(chatId: string): Promise<void>
}

/**
 * Subscriber callback for realtime events pushed from the client to the
 * main process and forwarded to the renderer.
 */
export type RealtimeListener = (envelope: RealtimeEnvelope) => void
export type TypingListener = (payload: TypingPayload) => void

export interface RealtimeSubscription {
  start(): Promise<void>
  stop(): Promise<void>
  onRealtime(listener: RealtimeListener): () => void
  onTyping(listener: TypingListener): () => void
}
