/**
 * Preload bridge: exposes a minimal, strongly-typed `rcm` API to the renderer
 * via contextBridge. No Node APIs are exposed — only the IPC invokers and the
 * push event subscribers.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AuthState, RealtimeEnvelope, TypingPayload } from '../shared/types.js'
import { IPC } from '../shared/types.js'
import type { RcmApi } from '../shared/rcmApi.js'

// The bridge type lives in shared/ so the renderer can import it without `electron`.
export type { RcmApi } from '../shared/rcmApi.js'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const subscribe = (
  channel: string,
  cb: (...args: unknown[]) => void
): (() => void) => {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RcmApi = {
  getConfig: () => invoke(IPC.GET_CONFIG),
  login: () => invoke(IPC.LOGIN),
  loginWithToken: () => invoke(IPC.LOGIN_WITH_TOKEN),
  logout: () => invoke(IPC.LOGOUT),
  getAuthState: () => invoke(IPC.GET_AUTH_STATE),
  getMe: () => invoke(IPC.GET_ME),
  getReadStates: () => invoke(IPC.GET_READ_STATES),
  getFirstStartedAt: () => invoke(IPC.GET_FIRST_STARTED_AT),
  getCachedMe: () => invoke(IPC.GET_CACHED_ME),
  getCachedChats: () => invoke(IPC.GET_CACHED_CHATS),
  getCachedPosts: (chatId) => invoke(IPC.GET_CACHED_POSTS, chatId),
  listRecentChats: () => invoke(IPC.LIST_RECENT_CHATS),
  listTeams: () => invoke(IPC.LIST_TEAMS),
  getTeam: (chatId) => invoke(IPC.GET_TEAM, chatId),
  createTeam: (args) => invoke(IPC.CREATE_TEAM, args),
  listPosts: (args) => invoke(IPC.LIST_POSTS, args),
  sendPost: (args) => invoke(IPC.SEND_POST, args),
  editPost: (args) => invoke(IPC.EDIT_POST, args),
  deletePost: (args) => invoke(IPC.DELETE_POST, args),
  uploadFile: (args) => invoke(IPC.UPLOAD_FILE, args),
  markChatRead: (chatId) => invoke(IPC.MARK_CHAT_READ, chatId),
  setTyping: (chatId) => invoke(IPC.SET_TYPING, chatId),
  openExternal: (url) => invoke(IPC.OPEN_EXTERNAL, url),
  updateSettings: (patch) => invoke(IPC.UPDATE_SETTINGS, patch),
  onAuthStateChanged: (cb) => subscribe(IPC.AUTH_STATE_CHANGED, (s) => cb(s as AuthState)),
  onRealtimeEvent: (cb) => subscribe(IPC.REALTIME_EVENT, (e) => cb(e as RealtimeEnvelope)),
  onRealtimeReconciled: (cb) => subscribe(IPC.REALTIME_RECONCILED, () => cb()),
  onTypingEvent: (cb) => subscribe(IPC.TYPING_EVENT, (p) => cb(p as TypingPayload))
}

contextBridge.exposeInMainWorld('rcm', api)

// Tell TypeScript the renderer knows about window.rcm.
export {}
