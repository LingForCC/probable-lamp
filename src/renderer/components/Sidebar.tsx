import { useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { getRcm } from '../lib/api'
import { Avatar } from './Avatar'
import { relativeTime, cx } from '../lib/utils'
import type { GlipChat } from '@shared/types'

interface SidebarProps {
  onOpenSettings: () => void
  onNewTeam: () => void
}

export function Sidebar({ onOpenSettings, onNewTeam }: SidebarProps) {
  const chats = useAppStore((s) => s.chats)
  const me = useAppStore((s) => s.me)
  const selectChat = useAppStore((s) => s.selectChat)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const runSearch = useAppStore((s) => s.runSearch)
  const search = useAppStore((s) => s.search)
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return chats
    return chats.filter((c) => chatName(c).toLowerCase().includes(f))
  }, [chats, filter])

  const totalUnread = chats.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
      {/* workspace header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-black text-white">
            RC
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">
              {me ? `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() : 'Workspace'}
            </p>
            <p className="truncate text-xs text-slate-400">{totalUnread} unread</p>
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          data-testid="settings-button"
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon />
        </button>
      </div>

      {/* search */}
      <div className="border-b border-slate-800 p-3">
        <input
          data-testid="search-input"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            void runSearch(getRcm(), e.target.value)
          }}
          placeholder="Search chats or messages"
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-brand-500 focus:outline-none"
        />
        {search && search.results.length > 0 && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 text-xs">
            <p className="px-3 py-1 text-slate-400">Message results</p>
            {search.results.slice(0, 8).map((r) => (
              <button
                key={r.id}
                data-testid={`search-result-${r.id}`}
                onClick={() => void selectChat(getRcm(), r.groupId)}
                className="block w-full truncate px-3 py-1.5 text-left hover:bg-slate-700"
              >
                {r.text}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* chat list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-testid="chat-list">
        <button
          onClick={onNewTeam}
          data-testid="new-team-button"
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          <PlusIcon /> New team
        </button>
        {filtered.length === 0 && (
          <p className="px-2 py-4 text-center text-sm text-slate-500">No chats found.</p>
        )}
        {filtered.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            active={chat.id === activeChatId}
            onClick={() => void selectChat(getRcm(), chat.id)}
          />
        ))}
      </div>
    </aside>
  )
}

function ChatRow({ chat, active, onClick }: { chat: GlipChat; active: boolean; onClick: () => void }) {
  const name = chatName(chat)
  const unread = chat.unreadCount ?? 0
  return (
    <button
      data-testid={`chat-row-${chat.id}`}
      onClick={onClick}
      className={cx(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition',
        active ? 'bg-slate-800' : 'hover:bg-slate-800/60'
      )}
    >
      <Avatar name={name} src={chat.avatar} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-slate-100">{name}</span>
          <span className="shrink-0 text-[10px] text-slate-500">
            {relativeTime(chat.lastModifiedTime)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-slate-400">{chat.lastMessage ?? 'No messages yet'}</span>
          {unread > 0 && (
            <span
              data-testid={`unread-${chat.id}`}
              className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white"
            >
              {unread}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

export function chatName(chat: GlipChat): string {
  if (chat.name) return chat.name
  if (chat.person) return `${chat.person.firstName ?? ''} ${chat.person.lastName ?? ''}`.trim()
  return chat.type === 'Everyone' ? 'Everyone' : 'Conversation'
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
