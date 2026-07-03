import { describe, expect, it, vi, beforeEach } from 'vitest'
import { shouldNotify, showPostNotification, resetNotificationDedupe } from '../../src/main/notifications'
import type { GlipPerson, PostEventBody } from '../../src/shared/types'

beforeEach(() => resetNotificationDedupe())

const me: GlipPerson = { id: 'me', firstName: 'Me' }
const other: GlipPerson = { id: 'u1', firstName: 'Alice' }

function makeEvent(overrides: Partial<PostEventBody> = {}): PostEventBody {
  return {
    eventType: 'PostAdded',
    id: 'p1',
    groupId: 'c1',
    creatorId: 'u1',
    text: 'hello',
    creationTime: new Date().toISOString(),
    ...overrides
  }
}

describe('shouldNotify', () => {
  it('notifies for a new post from someone else when not focused', () => {
    expect(shouldNotify(makeEvent(), me, false)).toBe(true)
  })

  it('skips our own posts', () => {
    expect(shouldNotify(makeEvent({ creatorId: 'me' }), me, false)).toBe(false)
  })

  it('skips when app is focused', () => {
    expect(shouldNotify(makeEvent(), me, true)).toBe(false)
  })

  it('dedupes by post id', () => {
    const e = makeEvent()
    expect(shouldNotify(e, me, false)).toBe(true)
    expect(shouldNotify(e, me, false)).toBe(false) // already shown
  })

  it('skips non-PostAdded events', () => {
    expect(shouldNotify(makeEvent({ eventType: 'PostUpdated' }), me, false)).toBe(false)
    expect(shouldNotify(makeEvent({ eventType: 'PostRemoved' }), me, false)).toBe(false)
  })
})

describe('showPostNotification', () => {
  it('sends a title with sender + chat name and a body preview', () => {
    const send = vi.fn()
    showPostNotification(
      makeEvent({ text: 'check this out:smell the roses' }),
      'Engineering',
      other,
      send
    )
    expect(send).toHaveBeenCalledOnce()
    const [title, body] = send.mock.calls[0]
    expect(title).toContain('Alice')
    expect(title).toContain('Engineering')
    expect(body).toContain('check this out')
  })

  it('truncates long message bodies', () => {
    const send = vi.fn()
    const long = 'x'.repeat(300)
    showPostNotification(makeEvent({ text: long }), 'Eng', other, send)
    const [, body] = send.mock.calls[0]
    expect(body.length).toBeLessThan(160)
    expect(body).toContain('…')
  })

  it('falls back to "New message" when sender is unknown', () => {
    const send = vi.fn()
    showPostNotification(makeEvent(), 'Eng', null, send)
    expect(send.mock.calls[0][0]).toContain('New message')
  })
})
