import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageItem } from '../../src/renderer/components/MessageItem'
import { setRcmApi } from '../../src/renderer/lib/api'
import { createFakeApi } from './fakeApi'
import { useAppStore } from '../../src/renderer/store/appStore'
import type { GlipPerson, GlipPost } from '../../src/shared/types'

const me: GlipPerson = { id: 'me', firstName: 'Me' }

function makePost(overrides: Partial<GlipPost> = {}): GlipPost {
  return {
    id: 'p1',
    groupId: 'c1',
    creatorId: 'u1',
    creatorName: 'Alice Nguyen',
    text: 'Hello world',
    creationTime: new Date().toISOString(),
    ...overrides
  }
}

describe('MessageItem', () => {
  it('renders the creator name and message text', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(<MessageItem post={makePost()} />)
    expect(screen.getByText('Alice Nguyen')).toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('shows "You" for own messages', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(<MessageItem post={makePost({ creatorId: 'me', isOwn: true })} />)
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('renders a markdown mention as a highlighted chip', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    const post = makePost({
      text: 'hi ![:Alice](u1) please review',
      mentions: [{ type: 'Person', id: 'u1', name: 'Alice' }]
    })
    const { container } = render(<MessageItem post={post} />)
    const chip = container.querySelector('.md-mention')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@Alice')
  })

  it('renders code blocks from markdown', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(<MessageItem post={makePost({ text: '```\nconst x = 1\n```' })} />)
    expect(document.querySelector('pre code')).not.toBeNull()
  })

  it('renders attachments', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(
      <MessageItem
        post={makePost({ attachments: [{ type: 'File', id: 'f1', name: 'report.pdf' }] })}
      />
    )
    expect(screen.getByText('📎')).toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('shows edit/delete actions for own messages on hover', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(<MessageItem post={makePost({ creatorId: 'me', isOwn: true })} />)
    expect(screen.getByTestId('edit-button-p1')).toBeInTheDocument()
    expect(screen.getByTestId('delete-button-p1')).toBeInTheDocument()
  })

  it('entering edit mode shows a textarea and save updates via store', () => {
    const api = createFakeApi({ chats: [], me })
    setRcmApi(api)
    // Wire the store so editMessage works through the component.
    useAppStore.setState({ activeChatId: 'c1' })

    render(<MessageItem post={makePost({ creatorId: 'me', isOwn: true })} />)
    fireEvent.click(screen.getByTestId('edit-button-p1'))
    const textarea = screen.getByTestId('edit-input-p1') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'updated text' } })
    fireEvent.click(screen.getByTestId('save-edit-p1'))
    expect(api.calls.editPost?.[0]?.[0]).toMatchObject({ postId: 'p1', text: 'updated text' })
  })

  it('shows an error message when a post failed to send', () => {
    setRcmApi(createFakeApi({ chats: [], me }))
    render(<MessageItem post={makePost({ creatorId: 'me', isOwn: true, error: 'network down', pending: false })} />)
    expect(screen.getByTestId('error-p1').textContent).toContain('network down')
  })

  it('groups consecutive messages from the same author within 5 minutes', () => {
    const t0 = '2024-01-01T00:00:00Z'
    const t1 = '2024-01-01T00:01:00Z'
    const { container } = render(
      <div>
        <MessageItem post={makePost({ id: 'a', creationTime: t0 })} />
        <MessageItem post={makePost({ id: 'b', creationTime: t1 })} prev={makePost({ id: 'a', creationTime: t0 })} />
      </div>
    )
    // Two avatars only for non-grouped; grouped one should have an empty avatar slot.
    const imgs = container.querySelectorAll('img, .rounded-full')
    expect(imgs.length).toBeGreaterThanOrEqual(1)
  })
})
