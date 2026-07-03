/**
 * Desktop notifications for incoming messages. Guarded by permission and a
 * best-effort deduper so we don't spam for the same post id.
 */
import { Notification } from 'electron'
import type { GlipPerson, PostEventBody } from '../shared/types.js'

const shown = new Set<string>()

/** Reset the dedupe set (used by tests). */
export function resetNotificationDedupe(): void {
  shown.clear()
}

export interface NotificationSender {
  (title: string, body: string): void
}

/** Default sender uses Electron Notification. */
export const electronNotification: NotificationSender = (title, body) => {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.show()
  } catch {
    /* ignore */
  }
}

export function shouldNotify(
  event: PostEventBody,
  me: GlipPerson | null,
  isFocused: boolean
): boolean {
  if (event.eventType !== 'PostAdded') return false
  // Don't notify for our own messages.
  if (event.creatorId === me?.id) return false
  // Don't notify if app is focused (user already sees it).
  if (isFocused) return false
  if (shown.has(event.id)) return false
  shown.add(event.id)
  return true
}

export function showPostNotification(
  event: PostEventBody,
  chatName: string,
  sender: GlipPerson | null,
  send: NotificationSender = electronNotification
): void {
  const title = `${sender ? nameOf(sender) : 'New message'} in ${chatName}`
  const body = stripPreview(event.text)
  send(title, body)
}

function nameOf(p: GlipPerson): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unknown'
}

function stripPreview(text: string): string {
  // Trim markdown noise for the notification body.
  const stripped = text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[#>*_`~]/g, '')
  return stripped.length > 140 ? stripped.slice(0, 137) + '…' : stripped
}
