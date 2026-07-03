import { marked } from 'marked'
import type { GlipMention, GlipPost } from '@shared/types'
import { clsx } from 'clsx'

export const cx = clsx

/**
 * Render a Glip post's text as HTML.
 * - Markdown via `marked`
 * - RingCentral mention syntax `![:Name](glip-person-id)` rendered as
 *   highlighted chips
 * - Output is sanitized: marked escapes HTML by default, and we strip any
 *   remaining raw <script>/onerror tokens defensively.
 */
export function renderPostText(post: GlipPost, knownMentions: GlipMention[] = []): string {
  let text = post.text ?? ''
  // Convert `![:Name](id)` and bare `![:Name:](id)` to @Name chips.
  text = text.replace(/!\[:([^\]]*)\]\(([^)]+)\)/g, (_m, name: string, id: string) => {
    const display = name || mentionName(id, knownMentions)
    return `[@${display}](#mention-${id})`
  })
  marked.setOptions({ breaks: true, gfm: true })
  let html = marked.parse(text, { async: false }) as string
  // Highlight mention anchors.
  html = html.replace(
    /<a href="#mention-([^"]+)">@([^<]+)<\/a>/g,
    '<span class="md-mention" data-mention-id="$1">@$2</span>'
  )
  return sanitizeHtml(html)
}

function mentionName(id: string, mentions: GlipMention[]): string {
  const m = mentions.find((x) => x.id === id)
  return m?.name ?? 'user'
}

/**
 * Minimal defensive sanitizer: drops <script>/<style>, event-handler attrs, and
 * javascript: URLs. marked already escapes inline HTML, but belt-and-braces.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"')
}

/** "10:30 AM", "Yesterday", "Mon", or a date. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString()
}

/** Relative "2m", "3h", "5d" for sidebar last-activity. */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return ''
  const diff = Date.now() - d
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Group consecutive posts by the same author within 5 minutes. */
export function shouldGroupWith(prev: GlipPost | undefined, curr: GlipPost): boolean {
  if (!prev) return false
  if (prev.creatorId !== curr.creatorId) return false
  const a = new Date(prev.creationTime).getTime()
  const b = new Date(curr.creationTime).getTime()
  return Math.abs(b - a) < 5 * 60_000
}

/** Initials for an avatar fallback. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** A deterministic color from a string (for avatar backgrounds). */
export function colorFromString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i)
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 65% 45%)`
}

export function postKey(post: GlipPost): string {
  return post.localId ?? post.id
}
