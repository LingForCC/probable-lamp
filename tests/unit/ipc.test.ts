import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * Unit tests for the main-process IpcController.
 *
 * The controller imports `electron` (ipcMain, BrowserWindow), so we mock the
 * module: ipcMain captures `handle`/`register` calls so tests can invoke the
 * registered handlers directly, and BrowserWindow.getAllWindows returns a
 * controllable list so `broadcast` is observable.
 */

// Captured IPC handlers registered by the controller: channel -> handler fn.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// Captured windows whose webContents.send we can observe.
let broadcastWindows: Array<{ webContents: { send: (ch: string, payload: unknown) => void } }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    getAllWindows: () => broadcastWindows
  }
}))

// Import AFTER vi.mock('electron') is registered.
import { IpcController } from '../../src/main/ipc'
import { IPC } from '../../src/shared/types'
import type {
  GlipPerson,
  IMessagingClient,
  RealtimeEnvelope,
  RealtimeListener,
  RealtimeSubscription,
  ServerConfig,
  TokenSet,
  TypingListener,
  TypingPayload
} from '../../src/shared/types'
import type { AppStore, AppSettings } from '../../src/main/store'
import type { AuthController } from '../../src/main/auth'

// ── fakes ────────────────────────────────────────────────────────────────────

function makeClient(overrides: Partial<IMessagingClient> = {}): IMessagingClient {
  return {
    isMock: true,
    setTokens: () => {},
    getTokens: () => null,
    getMe: async () => ({ id: 'me', firstName: 'Me' }),
    listRecentChats: async () => ({ records: [] }),
    listTeams: async () => [],
    getTeam: async () => ({ id: 't', type: 'Team' }),
    createTeam: async () => ({ id: 't', type: 'Team' }),
    listPosts: async () => ({ records: [] }),
    sendPost: async () => ({ id: 'p', groupId: 'c', creatorId: 'me', text: '', creationTime: '' }),
    editPost: async () => ({ id: 'p', groupId: 'c', creatorId: 'me', text: '', creationTime: '' }),
    deletePost: async () => {},
    uploadFile: async () => ({ type: 'File', id: 'f', name: 'n' }),
    searchPosts: async () => [],
    markChatRead: async () => {},
    setTyping: async () => {},
    ...overrides
  }
}

function makeStore(overrides: Partial<AppStore> = {}): AppStore {
  const settings: AppSettings = { theme: 'system', server: 'sandbox', apiMode: 'mock' }
  let readStates: Record<string, string> = {}
  const store = {
    settings,
    updateSettings: (patch: Partial<AppSettings>) => ({ ...settings, ...patch }),
    canEncrypt: () => true,
    saveTokens: (_tokens: TokenSet | null) => {},
    loadTokens: () => null as TokenSet | null,
    clearTokens: () => {},
    getReadStates: () => readStates,
    setReadState: (chatId: string, iso: string) => {
      readStates = { ...readStates, [chatId]: iso }
    },
    resolveConfig: (env: ServerConfig) => ({
      server: env.server,
      apiMode: env.apiMode,
      clientId: env.clientId,
      jwt: env.jwt
    }),
    ...overrides
  }
  return store as unknown as AppStore
}

function makeRealtime(): RealtimeSubscription & {
  realtimeCb: ((e: RealtimeEnvelope) => void) | null
  typingCb: ((p: TypingPayload) => void) | null
} {
  const rt = {
    realtimeCb: null as ((e: RealtimeEnvelope) => void) | null,
    typingCb: null as ((p: TypingPayload) => void) | null,
    async start() {},
    async stop() {},
    onRealtime(cb: RealtimeListener) {
      rt.realtimeCb = cb
      return () => {
        rt.realtimeCb = null
      }
    },
    onTyping(cb: TypingListener) {
      rt.typingCb = cb
      return () => {
        rt.typingCb = null
      }
    }
  }
  return rt
}

function makeAuth(): AuthController {
  // Only the surface the controller touches; cast to satisfy the type.
  return {
    login: async () => ({}) as never
  } as unknown as AuthController
}

function makeDeps(overrides: {
  client?: Partial<IMessagingClient>
  store?: Partial<AppStore>
} = {}) {
  return {
    client: makeClient(overrides.client),
    realtime: makeRealtime(),
    store: makeStore(overrides.store),
    auth: makeAuth(),
    config: { server: 'sandbox', apiMode: 'mock' } as ServerConfig,
    getFocusedWindow: () => null
  }
}

beforeEach(() => {
  handlers.clear()
  broadcastWindows = []
})

describe('IpcController read-state handlers', () => {
  it('GET_READ_STATES returns the persisted watermarks', async () => {
    const store = makeStore()
    store.setReadState('c1', '2024-01-01T00:00:00Z')
    store.setReadState('c2', '2024-02-01T00:00:00Z')
    IpcController.create(makeDeps({ store }))
    const result = await handlers.get(IPC.GET_READ_STATES)!({})
    expect(result).toEqual({
      c1: '2024-01-01T00:00:00Z',
      c2: '2024-02-01T00:00:00Z'
    })
  })

  it('MARK_CHAT_READ calls the client AND persists a read-state watermark', async () => {
    const markChatRead = vi.fn(async () => {})
    const store = makeStore()
    IpcController.create(makeDeps({ client: { markChatRead }, store }))
    await handlers.get(IPC.MARK_CHAT_READ)!({}, 'c1')
    // server-side mark
    expect(markChatRead).toHaveBeenCalledWith('c1')
    // local persistence: watermark now set to ~now (an ISO string)
    const wm = store.getReadStates()['c1']
    expect(typeof wm).toBe('string')
    expect(wm!.length).toBeGreaterThan(10)
    expect(() => new Date(wm!)).not.toThrow()
  })
})

describe('IpcController notifyRealtimeReconnected (debounced broadcast)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts REALTIME_RECONCILED after the 5s debounce', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    broadcastWindows = [
      { webContents: { send: (ch, payload) => sent.push({ channel: ch, payload }) } }
    ]
    const ctrl = IpcController.create(makeDeps())
    // Nothing broadcast yet.
    expect(sent.filter((s) => s.channel === IPC.REALTIME_RECONCILED)).toHaveLength(0)
    ctrl.notifyRealtimeReconnected()
    // Still nothing immediately (debounce window).
    expect(sent.filter((s) => s.channel === IPC.REALTIME_RECONCILED)).toHaveLength(0)
    // Fire after 5s.
    vi.advanceTimersByTime(5_000)
    const reconciles = sent.filter((s) => s.channel === IPC.REALTIME_RECONCILED)
    expect(reconciles).toHaveLength(1)
  })

  it('coalesces multiple notifications within the debounce window into one broadcast', () => {
    const sent: string[] = []
    broadcastWindows = [
      { webContents: { send: (ch) => sent.push(ch) } }
    ]
    const ctrl = IpcController.create(makeDeps())
    // Fire three times rapidly.
    ctrl.notifyRealtimeReconnected()
    ctrl.notifyRealtimeReconnected()
    ctrl.notifyRealtimeReconnected()
    vi.advanceTimersByTime(4_999)
    // Each call resets the timer; nothing sent yet.
    expect(sent.filter((c) => c === IPC.REALTIME_RECONCILED)).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(sent.filter((c) => c === IPC.REALTIME_RECONCILED)).toHaveLength(1)
  })

  it('broadcasts to every window', () => {
    let aCount = 0
    let bCount = 0
    broadcastWindows = [
      { webContents: { send: (ch) => { if (ch === IPC.REALTIME_RECONCILED) aCount++ } } },
      { webContents: { send: (ch) => { if (ch === IPC.REALTIME_RECONCILED) bCount++ } } }
    ]
    const ctrl = IpcController.create(makeDeps())
    ctrl.notifyRealtimeReconnected()
    vi.advanceTimersByTime(5_000)
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)
  })
})

describe('IpcController realtime forwarding', () => {
  it('forwards realtime envelopes to all windows via REALTIME_EVENT', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    broadcastWindows = [
      { webContents: { send: (ch, payload) => sent.push({ channel: ch, payload }) } }
    ]
    const deps = makeDeps()
    IpcController.create(deps)
    const envelope = { event: '/restapi/v1.0/team-messaging/posts', body: { eventType: 'PostAdded' } }
    deps.realtime.realtimeCb!(envelope)
    expect(sent.some((s) => s.channel === IPC.REALTIME_EVENT && s.payload === envelope)).toBe(true)
  })
})

// Touch imports to keep TS happy about unused types in this file's scope.
void (null as unknown as GlipPerson | TokenSet)
