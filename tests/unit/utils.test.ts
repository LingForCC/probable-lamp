import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  initials,
  relativeTime,
  renderPostText,
  sanitizeHtml,
  shouldGroupWith,
  colorFromString
} from '../../src/renderer/lib/utils'
import type { GlipPost } from '../../src/shared/types'

const makePost = (text: string, mentions: GlipPost['mentions'] = []): GlipPost =>
  ({ id: 'p', groupId: 'c', creatorId: 'u', text, creationTime: '2024-01-01T00:00:00Z', mentions }) as GlipPost

describe('renderPostText', () => {
  it('renders basic markdown', () => {
    const html = renderPostText(makePost('**bold**'))
    expect(html).toContain('<strong>bold</strong>')
  })

  it('converts RC mention syntax to a highlighted chip', () => {
    const html = renderPostText(
      makePost('hi ![:Alice](u1)', [{ type: 'Person', id: 'u1', name: 'Alice' }])
    )
    expect(html).toContain('md-mention')
    expect(html).toContain('@Alice')
    expect(html).toContain('data-mention-id="u1"')
  })

  it('falls back to "user" when mention name is unknown', () => {
    const html = renderPostText(makePost('hi ![:](u1)'))
    expect(html).toContain('@user')
  })

  it('strips script tags defensively', () => {
    const html = renderPostText(makePost('<script>alert(1)</script>'))
    expect(html).not.toContain('<script>')
  })
})

describe('sanitizeHtml', () => {
  it('removes event-handler attributes', () => {
    expect(sanitizeHtml('<div onclick="x()">hi</div>')).not.toContain('onclick')
  })

  it('neutralizes javascript: URLs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })
})

describe('formatTimestamp', () => {
  it('returns a time string for today', () => {
    const today = new Date().toISOString()
    expect(formatTimestamp(today)).toMatch(/\d/)
  })
  it('returns "Yesterday …" for yesterday', () => {
    const d = new Date(Date.now() - 86_400_000).toISOString()
    expect(formatTimestamp(d)).toContain('Yesterday')
  })
  it('returns empty for invalid input', () => {
    expect(formatTimestamp('not-a-date')).toBe('')
  })
})

describe('relativeTime', () => {
  it('returns "now" for very recent', () => {
    expect(relativeTime(new Date().toISOString())).toBe('now')
  })
  it('returns "Nm/Nh/Nd" buckets', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m')
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h')
    expect(relativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d')
  })
  it('returns empty for undefined', () => {
    expect(relativeTime(undefined)).toBe('')
  })
})

describe('shouldGroupWith', () => {
  it('groups same author within 5 minutes', () => {
    const base = '2024-01-01T00:00:00Z'
    const soon = '2024-01-01T00:04:00Z'
    expect(
      shouldGroupWith(
        { id: 'a', groupId: 'c', creatorId: 'u', text: '', creationTime: base },
        { id: 'b', groupId: 'c', creatorId: 'u', text: '', creationTime: soon }
      )
    ).toBe(true)
  })
  it('does not group different authors', () => {
    expect(
      shouldGroupWith(
        { id: 'a', groupId: 'c', creatorId: 'u1', text: '', creationTime: '2024-01-01T00:00:00Z' },
        { id: 'b', groupId: 'c', creatorId: 'u2', text: '', creationTime: '2024-01-01T00:01:00Z' }
      )
    ).toBe(false)
  })
  it('does not group when more than 5 minutes apart', () => {
    expect(
      shouldGroupWith(
        { id: 'a', groupId: 'c', creatorId: 'u', text: '', creationTime: '2024-01-01T00:00:00Z' },
        { id: 'b', groupId: 'c', creatorId: 'u', text: '', creationTime: '2024-01-01T00:10:00Z' }
      )
    ).toBe(false)
  })
})

describe('initials + colorFromString', () => {
  it('computes initials', () => {
    expect(initials('Alice Nguyen')).toBe('AN')
    expect(initials('Bob')).toBe('BO')
    expect(initials('')).toBe('?')
  })
  it('produces a stable hsl color', () => {
    expect(colorFromString('Alice')).toMatch(/^hsl\(/)
    expect(colorFromString('Alice')).toBe(colorFromString('Alice'))
    expect(colorFromString('Alice')).not.toBe(colorFromString('Bob'))
  })
})
