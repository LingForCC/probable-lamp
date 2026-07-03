import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/appStore'
import { MessageItem } from './MessageItem'
import { getRcm } from '../lib/api'

interface MessageListProps {
  chatId: string
}

export function MessageList({ chatId }: MessageListProps) {
  const msgs = useAppStore((s) => s.messages[chatId])
  const loadMore = useAppStore((s) => s.loadMoreMessages)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasNearBottom = useRef(true)

  // Load more when scrolled to the top.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && msgs?.hasMore && !msgs.loadingMore) {
      const prevHeight = el.scrollHeight
      void loadMore(getRcm()).then(() => {
        // keep scroll position stable after prepending older messages
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop += scrollRef.current.scrollHeight - prevHeight
        })
      })
    }
  }

  // Auto-scroll to bottom when new messages arrive (if user was near bottom).
  useEffect(() => {
    const el = scrollRef.current
    if (el && wasNearBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [msgs?.posts.length])

  const posts = msgs?.posts ?? []
  if (posts.length === 0) {
    return (
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-500"
        data-testid="empty-chat"
      >
        No messages yet. Say hello 👋
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      data-testid="message-list"
    >
      {msgs?.loadingMore && (
        <div className="py-2 text-center text-xs text-slate-500">Loading older messages…</div>
      )}
      {posts.map((p, i) => (
        <MessageItem key={p.localId ?? p.id} post={p} prev={posts[i - 1]} />
      ))}
    </div>
  )
}
