import { useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { getRcm } from '../lib/api'

export function Composer() {
  const sendText = useAppStore((s) => s.sendText)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const setTyping = useAppStore((s) => s.setTyping)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const lastTyping = useRef(0)

  const send = async () => {
    const value = text.trim()
    if (!value || !activeChatId) return
    setSending(true)
    setText('')
    autoGrow()
    try {
      await sendText(getRcm(), value)
    } finally {
      setSending(false)
      taRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    autoGrow()
    // Throttle typing notifications to once / 3s.
    const now = Date.now()
    if (now - lastTyping.current > 3000 && activeChatId) {
      lastTyping.current = now
      void setTyping(getRcm(), activeChatId)
    }
  }

  const autoGrow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3">
      <div className="flex items-end gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 focus-within:border-brand-500">
        <textarea
          ref={taRef}
          data-testid="composer-input"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message…  (Enter to send, Shift+Enter for newline)"
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
        />
        <button
          data-testid="send-button"
          onClick={() => void send()}
          disabled={sending || !text.trim()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40"
        >
          Send
        </button>
      </div>
      <p className="mt-1 px-1 text-[10px] text-slate-500">
        Supports Markdown and @mentions. Use <code className="text-slate-400">![:Name](personId)</code> to mention.
      </p>
    </div>
  )
}
