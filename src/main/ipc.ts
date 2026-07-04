/**
 * Main-process IPC controller.
 *
 * Registers handlers for every channel in {@link IPC} and forwards requests to
 * the messaging client / realtime source. Pushes realtime events back to the
 * focused window via {@link IPC.REALTIME_EVENT}.
 *
 * Kept dependency-injectable (client, realtime, store, auth) so it can be
 * unit-tested without spinning up Electron.
 */
import { BrowserWindow, ipcMain } from 'electron'
import type {
  AuthState,
  GlipAttachment,
  GlipMention,
  GlipPerson,
  IMessagingClient,
  IPC as IPCType,
  PostEventBody,
  RealtimeEnvelope,
  RealtimeSubscription,
  ServerConfig
} from '../shared/types.js'
import { IPC } from '../shared/types.js'
import type { AppStore } from './store.js'
import type { AuthController } from './auth.js'
import { shouldNotify, showPostNotification } from './notifications.js'

export interface IpcDeps {
  client: IMessagingClient
  realtime: RealtimeSubscription
  store: AppStore
  auth: AuthController
  config: ServerConfig
  /** Get the currently focused window (may be null). */
  getFocusedWindow: () => BrowserWindow | null
  /** Resolve a person by id (best-effort, for notifications). */
  resolvePerson?: (id: string) => GlipPerson | null
}

export class IpcController {
  private me: GlipPerson | null = null
  /** Debounce timer for REALTIME_RECONCILED broadcasts (coalesce wake + reconnect). */
  private reconcileTimer: NodeJS.Timeout | null = null
  private constructor(private readonly deps: IpcDeps) {}

  static create(deps: IpcDeps): IpcController {
    const ctrl = new IpcController(deps)
    ctrl.registerAll()
    ctrl.startRealtimeForwarding()
    return ctrl
  }

  private registerAll(): void {
    const { client, store, config } = this.deps

    ipcMain.handle(IPC.GET_CONFIG, () => ({
      // `server`/`apiMode` come from the resolved (env-driven) config; `theme`
      // is the only user-controlled setting. Never expose secrets (jwt).
      server: config.server,
      apiMode: config.apiMode,
      theme: store.settings.theme
    }))

    ipcMain.handle(IPC.LOGIN, async () => this.performLogin())

    ipcMain.handle(IPC.LOGIN_WITH_TOKEN, async () => {
      // Mock mode login: auth.login handles installing the fake token.
      return this.performLogin()
    })

    ipcMain.handle(IPC.LOGOUT, async () => {
      try {
        await this.deps.realtime.stop()
      } finally {
        store.clearTokens()
        client.setTokens(null)
        this.me = null
        this.broadcast(IPC.AUTH_STATE_CHANGED, { status: 'loggedOut' } satisfies AuthState)
      }
      return { status: 'loggedOut' } satisfies AuthState
    })

    ipcMain.handle(IPC.GET_AUTH_STATE, () => {
      if (this.me) {
        return { status: 'loggedIn', me: this.me } satisfies AuthState
      }
      return { status: 'loggedOut' } satisfies AuthState
    })

    ipcMain.handle(IPC.GET_ME, async () => {
      if (!this.me) this.me = await client.getMe()
      return this.me
    })

    ipcMain.handle(IPC.GET_READ_STATES, () => store.getReadStates())

    ipcMain.handle(IPC.LIST_RECENT_CHATS, () => client.listRecentChats())
    ipcMain.handle(IPC.LIST_TEAMS, () => client.listTeams())
    ipcMain.handle(IPC.GET_TEAM, (_e, chatId: string) => client.getTeam(chatId))
    ipcMain.handle(
      IPC.CREATE_TEAM,
      (_e, args: { name: string; members?: string[]; description?: string }) =>
        client.createTeam(args.name, args.members, args.description)
    )
    ipcMain.handle(
      IPC.LIST_POSTS,
      (_e, args: { chatId: string; pageToken?: string; recordCount?: number }) =>
        client.listPosts(args.chatId, { pageToken: args.pageToken, recordCount: args.recordCount })
    )
    ipcMain.handle(
      IPC.SEND_POST,
      (
        _e,
        args: {
          chatId: string
          text: string
          mentions?: GlipMention[]
          attachments?: GlipAttachment[]
        }
      ) =>
        client.sendPost(args.chatId, args.text, {
          mentions: args.mentions,
          attachments: args.attachments
        })
    )
    ipcMain.handle(
      IPC.EDIT_POST,
      (_e, args: { chatId: string; postId: string; text: string }) =>
        client.editPost(args.chatId, args.postId, args.text)
    )
    ipcMain.handle(
      IPC.DELETE_POST,
      (_e, args: { chatId: string; postId: string }) => client.deletePost(args.chatId, args.postId)
    )
    ipcMain.handle(
      IPC.UPLOAD_FILE,
      (_e, args: { chatId: string; name: string; type: string; data: number[] }) =>
        client.uploadFile(args.chatId, {
          name: args.name,
          type: args.type,
          data: new Uint8Array(args.data)
        })
    )
    ipcMain.handle(IPC.SEARCH_POSTS, (_e, text: string) => client.searchPosts(text))
    ipcMain.handle(IPC.MARK_CHAT_READ, async (_e, chatId: string) => {
      // Tell the server the chat was read, AND persist the local read-state
      // watermark so the next cold start computes unread from "now".
      await client.markChatRead(chatId)
      store.setReadState(chatId, new Date().toISOString())
    })
    ipcMain.handle(IPC.SET_TYPING, (_e, chatId: string) => client.setTyping(chatId))

    ipcMain.handle(IPC.OPEN_EXTERNAL, (_e, url: string) => {
      void import('electron').then(({ shell }) => shell.openExternal(url))
      return true
    })

    ipcMain.handle(IPC.UPDATE_SETTINGS, (_e, patch: Partial<{ theme: 'light' | 'dark' | 'system' }>) => {
      return store.updateSettings(patch as never)
    })
  }

  /**
   * Shared login sequence used by both the IPC LOGIN handler and the auto-login
   * at boot. Exchanges credentials (JWT in real mode, fake in mock mode), loads
   * the current user, starts realtime, and broadcasts the new auth state.
   */
  async performLogin(): Promise<AuthState> {
    const { client, store, auth } = this.deps
    const tokens = await auth.login()
    store.saveTokens(tokens)
    client.setTokens(tokens)
    const me = await client.getMe()
    this.me = me
    await this.deps.realtime.start()
    this.broadcast(IPC.AUTH_STATE_CHANGED, {
      status: 'loggedIn',
      me
    } satisfies AuthState)
    return { status: 'loggedIn', me } satisfies AuthState
  }

  /**
   * Push an auth state to the renderer (used for auto-login result/ error at
   * boot). Does not touch the client/store — callers handle those.
   */
  pushAuthState(state: AuthState): void {
    if (state.status === 'loggedIn') this.me = state.me
    this.broadcast(IPC.AUTH_STATE_CHANGED, state)
  }

  /** Forward realtime envelopes + typing events to windows and fire notifications. */
  private startRealtimeForwarding(): void {
    this.deps.realtime.onRealtime((envelope: RealtimeEnvelope) => {
      this.broadcast(IPC.REALTIME_EVENT, envelope)
      this.maybeNotify(envelope)
    })
    // Forward typing indicators to the renderer so the UI can show "X is typing…".
    this.deps.realtime.onTyping((payload) => {
      this.broadcast(IPC.TYPING_EVENT, payload)
    })
  }

  private maybeNotify(envelope: RealtimeEnvelope): void {
    const body = envelope.body
    if (!body || typeof body !== 'object') return
    const event = body as { eventType?: string } & Partial<PostEventBody>
    if (event.eventType !== 'PostAdded') return
    const focused = this.deps.getFocusedWindow()?.isFocused() ?? false
    const postEvent = event as PostEventBody
    if (!shouldNotify(postEvent, this.me, focused)) return
    const sender = this.deps.resolvePerson?.(postEvent.creatorId ?? '') ?? null
    showPostNotification(postEvent, 'Chat', sender)
  }

  private broadcast(channel: (typeof IPCType)[keyof typeof IPCType], payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  /** Allow main to push typing events to renderer (typed for completeness). */
  forwardTyping(payload: unknown): void {
    this.broadcast(IPC.TYPING_EVENT, payload)
  }

  /**
   * Notify the renderer that realtime may have been interrupted (socket
   * reconnect or system wake), so it should re-reconcile unread counts from
   * the persisted watermark. Debounced 5s so a wake that also causes a socket
   * reconnect fires only one reconcile.
   */
  notifyRealtimeReconnected(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.broadcast(IPC.REALTIME_RECONCILED, undefined)
    }, 5_000)
  }
}
