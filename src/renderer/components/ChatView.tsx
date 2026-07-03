import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/appStore'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { Avatar } from './Avatar'
import { chatName } from './Sidebar'
import type { GlipChat } from '@shared/types'

export function ChatView() {
  const activeChatId = useAppStore((s) => s.activeChatId)
  const chats = useAppStore((s) => s.chats)
  const typing = useAppStore((s) => s.typing)
  const me = useAppStore((s) => s.me)

  const chat = chats.find((c) => c.id === activeChatId) as GlipChat | undefined
  const topRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'end' })
  }, [activeChatId])

  if (!chat || !activeChatId) return null
  const name = chatName(chat)
  const typers = typing[activeChatId] ?? []
  const typingText =
    typers.length === 0
      ? ''
      : typers.length === 1
        ? `${typers[0].personName} is typing…`
        : `${typers.length} people are typing…`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/60 px-4 py-2.5 backdrop-blur">
        <Avatar name={name} src={chat.avatar} size={32} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100" data-testid="active-chat-name">
            {name}
          </h2>
          <p className="truncate text-xs text-slate-400">
            {chat.type === 'Direct' && chat.person
              ? chat.person.email ?? 'Direct message'
              : `${chat.membersCount ?? 0} members`}
          </p>
        </div>
        <span className="ml-auto text-xs text-slate-500">{me?.email}</span>
      </header>

      <MessageList chatId={activeChatId} />
      <div className="h-5 px-4 text-xs text-slate-400">
        <span data-testid="typing-indicator">{typingText}</span>
      </div>
      <Composer />
    </div>
  )
}
