/**
 * In-memory mock RingCentral messaging client + realtime source.
 *
 * Implements the same {@link IMessagingClient} interface as the real REST
 * client, plus a {@link RealtimeSubscription}. The data lives in memory and is
 * mutated by send/edit/delete. Optional simulated realtime: after a configurable
 * delay the mock emits a `PostAdded` event as if a teammate replied.
 *
 * This is what powers MOCK mode (`RC_API_MODE=mock`) so the app and all tests
 * run with zero credentials and zero network.
 */

import type {
  GlipAttachment,
  GlipChat,
  GlipMention,
  GlipPerson,
  GlipPost,
  GlipTeam,
  IMessagingClient,
  PageResult,
  RealtimeEnvelope,
  RealtimeListener,
  RealtimeSubscription,
  TokenSet,
  TypingListener,
  TypingPayload
} from '../../types.js'

export interface MockOptions {
  /** ms before the simulated "teammate" posts a reply after a send. 0 disables. */
  autoReplyMs?: number
  /** Injected scheduler for deterministic tests. */
  schedule?: (fn: () => void, ms: number) => void
  /** Injected clock. */
  now?: () => number
  /** Seed people (besides the current user). */
  people?: GlipPerson[]
}

interface MockState {
  me: GlipPerson
  people: Map<string, GlipPerson>
  chats: Map<string, GlipChat>
  teams: Map<string, GlipTeam>
  posts: Map<string, GlipPost[]> // chatId -> posts (chronological)
}

const ME: GlipPerson = {
  id: 'me',
  firstName: 'You',
  lastName: '(Mock)',
  email: 'me@example.com',
  avatar: '',
  presence: { presenceStatus: 'Available' }
}

function seed(people: GlipPerson[]): MockState {
  const personMap = new Map<string, GlipPerson>()
  personMap.set(ME.id, ME)
  for (const p of people) personMap.set(p.id, p)

  const alice = personMap.get('p1') ?? makePerson('p1', 'Alice', 'Nguyen')
  const bob = personMap.get('p2') ?? makePerson('p2', 'Bob', 'Martinez')
  const carol = personMap.get('p3') ?? makePerson('p3', 'Carol', 'Okafor')
  for (const p of [alice, bob, carol]) personMap.set(p.id, p)

  const general: GlipTeam = {
    id: 'team-general',
    type: 'Team',
    name: 'Engineering',
    description: 'The whole engineering org',
    membersCount: 3,
    lastModifiedTime: isoMinutesAgo(2),
    lastMessage: 'Carol: shipping the release now 🚀'
  }
  const design: GlipTeam = {
    id: 'team-design',
    type: 'Team',
    name: 'Design',
    description: 'Product design',
    membersCount: 2,
    lastModifiedTime: isoMinutesAgo(60),
    lastMessage: 'Alice: new mockups in Figma'
  }
  const dm: GlipChat = {
    id: 'chat-dm-alice',
    type: 'Direct',
    person: alice,
    membersCount: 2,
    lastModifiedTime: isoMinutesAgo(30),
    lastMessage: 'Alice: hey, got a sec?'
  }
  const group: GlipChat = {
    id: 'chat-group-lunch',
    type: 'Group',
    name: 'Lunch Club',
    membersCount: 3,
    lastModifiedTime: isoMinutesAgo(120),
    lastMessage: 'Bob: tacos again?'
  }

  const chats = new Map<string, GlipChat>()
  chats.set(general.id, general)
  chats.set(design.id, design)
  chats.set(dm.id, dm)
  chats.set(group.id, group)

  const teams = new Map<string, GlipTeam>()
  teams.set(general.id, general)
  teams.set(design.id, design)

  const posts = new Map<string, GlipPost[]>()
  posts.set(general.id, [
    post('team-general', bob.id, "morning all — what's on deck?", 60 * 5),
    post('team-general', alice.id, 'standup in 10', 60 * 4),
    post('team-general', ME.id, 'I will lead standup today', 60 * 3),
    post('team-general', carol.id, 'shipping the release now 🚀', 2)
  ])
  posts.set(design.id, [
    post('team-design', alice.id, 'new mockups in Figma', 60),
    post('team-design', bob.id, 'looks great 👀', 59)
  ])
  posts.set(dm.id, [
    post('chat-dm-alice', alice.id, 'hey, got a sec?', 30),
    post('chat-dm-alice', ME.id, 'sure, what’s up?', 28)
  ])
  posts.set(group.id, [
    post('chat-group-lunch', bob.id, 'tacos again?', 120)
  ])

  return { me: ME, people: personMap, chats, teams, posts }
}

function makePerson(id: string, first: string, last: string): GlipPerson {
  return {
    id,
    firstName: first,
    lastName: last,
    email: `${first.toLowerCase()}@example.com`,
    avatar: '',
    presence: { presenceStatus: 'Available' }
  }
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString()
}

function post(groupId: string, creatorId: string, text: string, minutesAgo: number): GlipPost {
  const created = Date.now() - minutesAgo * 60_000
  return {
    id: `post-${groupId}-${created}-${Math.floor(Math.random() * 10000)}`,
    groupId,
    type: 'TextMessage',
    creatorId,
    text,
    creationTime: new Date(created).toISOString(),
    lastModifiedTime: new Date(created).toISOString(),
    status: 'Active'
  }
}

export class MockMessagingClient implements IMessagingClient, RealtimeSubscription {
  readonly isMock = true
  private tokens: TokenSet | null = null
  private state: MockState
  private realtimeListeners = new Set<RealtimeListener>()
  private typingListeners = new Set<TypingListener>()
  private running = false
  private idCounter = 1
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly now: () => number
  private readonly autoReplyMs: number

  constructor(opts: MockOptions = {}) {
    this.state = seed(opts.people ?? [])
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.now = opts.now ?? Date.now
    this.autoReplyMs = opts.autoReplyMs ?? 1500
  }

  // ── tokens (mock) ────────────────────────────────────────────────────────

  setTokens(tokens: TokenSet | null): void {
    this.tokens = tokens
  }
  getTokens(): TokenSet | null {
    if (!this.tokens) return null
    return this.tokens
  }

  /** Mock login shortcut: install a fake token set. */
  login(): TokenSet {
    this.tokens = {
      access_token: 'mock-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'TeamMessaging',
      owner_id: this.state.me.id,
      obtainedAt: this.now()
    }
    return this.tokens
  }

  // ── enrichment ───────────────────────────────────────────────────────────

  private enrich(p: GlipPost): GlipPost {
    const creator = this.state.people.get(p.creatorId)
    return {
      ...p,
      isOwn: p.creatorId === this.state.me.id,
      creatorName: creator ? `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim() : 'Unknown',
      creatorAvatar: creator?.avatar
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter++}`
  }

  // ── IMessagingClient ─────────────────────────────────────────────────────

  async getMe(): Promise<GlipPerson> {
    return this.state.me
  }

  async listChats(): Promise<PageResult<GlipChat>> {
    const records = Array.from(this.state.chats.values())
    records.sort((a, b) =>
      (b.lastModifiedTime ?? '').localeCompare(a.lastModifiedTime ?? '')
    )
    return { records }
  }

  async listTeams(): Promise<GlipTeam[]> {
    return Array.from(this.state.teams.values())
  }

  async getTeam(chatId: string): Promise<GlipTeam> {
    const t = this.state.teams.get(chatId)
    if (!t) throw notFound(`team ${chatId}`)
    return t
  }

  async createTeam(name: string, members: string[] = [], description?: string): Promise<GlipTeam> {
    const id = this.nextId('team')
    const team: GlipTeam = {
      id,
      type: 'Team',
      name,
      description,
      membersCount: 1 + members.length,
      lastModifiedTime: new Date(this.now()).toISOString()
    }
    this.state.teams.set(id, team)
    this.state.chats.set(id, team)
    this.state.posts.set(id, [])
    return team
  }

  async listPosts(
    chatId: string,
    opts: { pageToken?: string; recordCount?: number } = {}
  ): Promise<PageResult<GlipPost>> {
    const all = (this.state.posts.get(chatId) ?? []).slice().reverse() // newest first
    const pageSize = opts.recordCount ?? 50
    const start = opts.pageToken ? Number(opts.pageToken) : 0
    const slice = all.slice(start, start + pageSize)
    const nextStart = start + slice.length
    const nextPageToken = nextStart < all.length ? String(nextStart) : undefined
    return { records: slice.map((p) => this.enrich(p)), nextPageToken }
  }

  async sendPost(
    chatId: string,
    text: string,
    opts: { mentions?: GlipMention[]; attachments?: GlipAttachment[] } = {}
  ): Promise<GlipPost> {
    const me = this.state.me
    const created = this.now()
    const post: GlipPost = {
      id: this.nextId('post'),
      groupId: chatId,
      type: 'TextMessage',
      creatorId: me.id,
      text,
      mentions: opts.mentions,
      attachments: opts.attachments,
      creationTime: new Date(created).toISOString(),
      lastModifiedTime: new Date(created).toISOString(),
      status: 'Active'
    }
    const list = this.state.posts.get(chatId) ?? []
    list.push(post)
    this.state.posts.set(chatId, list)
    this.bumpChat(chatId, text)
    this.maybeAutoReply(chatId)
    return this.enrich(post)
  }

  async editPost(chatId: string, postId: string, text: string): Promise<GlipPost> {
    const list = this.state.posts.get(chatId) ?? []
    const idx = list.findIndex((p) => p.id === postId)
    if (idx < 0) throw notFound(`post ${postId}`)
    const updated: GlipPost = {
      ...list[idx],
      text,
      lastModifiedTime: new Date(this.now()).toISOString()
    }
    list[idx] = updated
    return this.enrich(updated)
  }

  async deletePost(chatId: string, postId: string): Promise<void> {
    const list = this.state.posts.get(chatId) ?? []
    const idx = list.findIndex((p) => p.id === postId)
    if (idx < 0) throw notFound(`post ${postId}`)
    list.splice(idx, 1)
  }

  async uploadFile(
    _chatId: string,
    file: { name: string; type: string; data: Uint8Array }
  ): Promise<GlipAttachment> {
    const id = this.nextId('file')
    return {
      type: 'File',
      id,
      name: file.name,
      contentUri: `mock://files/${id}`
    }
  }

  async searchPosts(text: string): Promise<GlipPost[]> {
    const q = text.toLowerCase()
    const out: GlipPost[] = []
    for (const list of this.state.posts.values()) {
      for (const p of list) {
        if (p.text.toLowerCase().includes(q)) out.push(this.enrich(p))
      }
    }
    return out
  }

  async markChatRead(chatId: string): Promise<void> {
    // Unread tracking is a renderer-side concern (watermark-based); the mock
    // only needs to acknowledge the read. The IPC layer persists the watermark.
    void chatId
  }

  async setTyping(_chatId: string): Promise<void> {
    // Typing is one-way to the server; the mock keeps it simple.
  }

  // ── RealtimeSubscription ─────────────────────────────────────────────────

  onRealtime(listener: RealtimeListener): () => void {
    this.realtimeListeners.add(listener)
    return () => this.realtimeListeners.delete(listener)
  }

  onTyping(listener: TypingListener): () => void {
    this.typingListeners.add(listener)
    return () => this.typingListeners.delete(listener)
  }

  async start(): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  /** Test/realtime helper: emit an envelope as if the server pushed it. */
  emit(envelope: RealtimeEnvelope): void {
    for (const l of this.realtimeListeners) l(envelope)
  }

  /** Test/realtime helper: emit a typing indicator. */
  emitTyping(payload: TypingPayload): void {
    for (const l of this.typingListeners) l(payload)
  }

  /** Emit a post-added event for a post that already exists in state. */
  private emitPostAdded(p: GlipPost): void {
    const envelope: RealtimeEnvelope = {
      event: '/restapi/v1.0/glip/posts',
      timestamp: new Date(this.now()).toISOString(),
      body: { ...p, eventType: 'PostAdded' }
    }
    this.emit(envelope)
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private bumpChat(chatId: string, lastText: string): void {
    const c = this.state.chats.get(chatId)
    if (c) {
      c.lastMessage = lastText.length > 80 ? lastText.slice(0, 77) + '…' : lastText
      c.lastModifiedTime = new Date(this.now()).toISOString()
    }
  }

  private maybeAutoReply(chatId: string): void {
    if (this.autoReplyMs <= 0 || !this.running) return
    // Pick a teammate (not me) that belongs to this chat deterministically.
    const creatorIds = (this.state.posts.get(chatId) ?? [])
      .map((p) => p.creatorId)
      .filter((id) => id !== this.state.me.id)
    if (creatorIds.length === 0) return
    const replierId = creatorIds[creatorIds.length - 1]
    const replier = this.state.people.get(replierId)
    if (!replier) return
    const chat = this.state.chats.get(chatId)
    const name = chat?.name ?? `${replier.firstName ?? 'Someone'}`
    const replies = [
      '👍 sounds good',
      'thanks!',
      'will take a look',
      'cool',
      'let me check and get back to you'
    ]
    const text = replies[Math.floor(Math.random() * replies.length)]
    this.schedule(() => {
      const created = this.now()
      const reply: GlipPost = {
        id: this.nextId('post'),
        groupId: chatId,
        type: 'TextMessage',
        creatorId: replierId,
        text,
        creationTime: new Date(created).toISOString(),
        lastModifiedTime: new Date(created).toISOString(),
        status: 'Active'
      }
      const list = this.state.posts.get(chatId) ?? []
      list.push(reply)
      this.bumpChat(chatId, `${name}: ${text}`)
      // bump unread for chats other than the currently focused one? keep simple: no
      this.emitPostAdded(reply)
    }, this.autoReplyMs)
  }
}

function notFound(what: string): Error {
  const e = new Error(`Not found: ${what}`)
  e.name = 'NotFoundError'
  return e
}
