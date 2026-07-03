import { useState } from 'react'
import type { GlipAttachment, GlipPost } from '@shared/types'
import { Avatar } from './Avatar'
import { formatTimestamp, renderPostText, shouldGroupWith, cx } from '../lib/utils'
import { useAppStore } from '../store/appStore'
import { getRcm } from '../lib/api'

interface MessageItemProps {
  post: GlipPost
  prev?: GlipPost
}

export function MessageItem({ post, prev }: MessageItemProps) {
  const editMessage = useAppStore((s) => s.editMessage)
  const deleteMessage = useAppStore((s) => s.deleteMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(post.text)
  const grouped = shouldGroupWith(prev, post)
  const name = post.creatorName ?? 'Unknown'
  const html = renderPostText(post, post.mentions)

  const startEdit = () => {
    setDraft(post.text)
    setEditing(true)
  }
  const saveEdit = () => {
    setEditing(false)
    if (draft !== post.text) void editMessage(getRcm(), post.id, draft)
  }
  const onDelete = () => {
    if (confirm('Delete this message?')) void deleteMessage(getRcm(), post.id)
  }

  return (
    <div
      data-testid={`message-${post.id}`}
      className={cx(
        'group relative flex gap-3 px-2 py-0.5',
        grouped ? 'mt-0.5' : 'mt-3',
        post.isOwn && 'bg-slate-900/30'
      )}
    >
      <div className="w-9 shrink-0">
        {!grouped && <Avatar name={name} src={post.creatorAvatar} size={36} />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-slate-100">
              {post.isOwn ? 'You' : name}
            </span>
            <span className="text-[10px] text-slate-500" title={post.creationTime}>
              {formatTimestamp(post.creationTime)}
            </span>
            {post.lastModifiedTime && post.lastModifiedTime !== post.creationTime && (
              <span className="text-[10px] italic text-slate-600">(edited)</span>
            )}
          </div>
        )}
        {editing ? (
          <div className="mt-1 flex flex-col gap-1">
            <textarea
              data-testid={`edit-input-${post.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
              rows={2}
            />
            <div className="flex gap-2 text-xs">
              <button
                data-testid={`save-edit-${post.id}`}
                onClick={saveEdit}
                className="rounded bg-brand-600 px-2 py-0.5 text-white hover:bg-brand-500"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded bg-slate-700 px-2 py-0.5 text-slate-200 hover:bg-slate-600"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="selectable md-body text-sm text-slate-200"
            // HTML is sanitized in renderPostText (marked escapes + defensive strip)
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {post.attachments && post.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {post.attachments.map((a, i) => (
              <Attachment key={i} attachment={a} />
            ))}
          </div>
        )}
        {post.error && (
          <p className="mt-1 text-xs text-red-400" data-testid={`error-${post.id}`}>
            Failed to send: {post.error}
          </p>
        )}
      </div>
      {/* hover actions for own messages */}
      {post.isOwn && !editing && (
        <div className="absolute -top-3 right-2 hidden gap-1 rounded-md border border-slate-700 bg-slate-800 px-1 py-0.5 text-xs group-hover:flex">
          <button
            data-testid={`edit-button-${post.id}`}
            onClick={startEdit}
            className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-700"
          >
            Edit
          </button>
          <button
            data-testid={`delete-button-${post.id}`}
            onClick={onDelete}
            className="rounded px-1.5 py-0.5 text-red-300 hover:bg-slate-700"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

function Attachment({ attachment }: { attachment: GlipAttachment }) {
  if (attachment.type === 'File' || attachment.type === 'Event' || attachment.type === 'Note' || attachment.type === 'Task') {
    return (
      <a
        href={attachment.contentUri ?? '#'}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
      >
        <span>📎</span>
        <span>{attachment.name ?? attachment.title ?? 'attachment'}</span>
      </a>
    )
  }
  if (attachment.type === 'Card') {
    return (
      <div className="rounded-md border border-slate-700 bg-slate-800 p-2 text-xs">
        {attachment.title && <p className="font-semibold text-slate-100">{attachment.title}</p>}
        {attachment.text && <p className="text-slate-300">{attachment.text}</p>}
      </div>
    )
  }
  return null
}
