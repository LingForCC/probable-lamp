import { test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMockApp, expect } from './fixtures'

/**
 * End-to-end flow driving the real Electron app in MOCK mode (no RingCentral
 * credentials or network). Covers: login → sidebar chats → open chat →
 * send message → receive simulated realtime reply → edit → delete → settings
 * theme toggle → logout.
 */

// Helper: a locator scoped to the message list, to avoid matching the sidebar
// preview text (which duplicates message snippets).
const messageListText = (window: Page, text: string) =>
  window.getByTestId('message-list').getByText(text)

test.describe('RC Messenger (MOCK mode E2E)', () => {
  test('full messaging flow', async () => {
    const { app, window } = await launchMockApp()

    // ── Login ────────────────────────────────────────────────────────────────
    await expect(window.getByTestId('login-button')).toBeVisible({ timeout: 30_000 })
    await window.getByTestId('login-button').click()

    // ── Sidebar shows seeded chats ───────────────────────────────────────────
    const chatList = window.getByTestId('chat-list')
    await expect(chatList).toBeVisible()
    await expect(window.getByTestId('chat-row-team-general')).toBeVisible()
    await expect(window.getByTestId('chat-row-chat-dm-alice')).toBeVisible()
    await expect(window.getByTestId('unread-team-general')).toBeVisible()

    // ── Open a chat and see seeded messages ──────────────────────────────────
    await window.getByTestId('chat-row-team-general').click()
    await expect(window.getByTestId('active-chat-name')).toHaveText(/Engineering/)
    await expect(messageListText(window, 'shipping the release now')).toBeVisible()

    // ── Send a message ───────────────────────────────────────────────────────
    const composer = window.getByTestId('composer-input')
    await composer.fill('E2E hello world')
    await window.getByTestId('send-button').click()
    await expect(messageListText(window, 'E2E hello world')).toBeVisible()

    // ── Receive a simulated realtime reply (mock auto-reply) ─────────────────
    await expect
      .poll(
        async () => {
          const msgs = (await window.getByTestId('message-list').innerText()) ?? ''
          return /(thanks|will take a look|cool|let me check)/.test(msgs)
        },
        { timeout: 15_000, intervals: [500] }
      )
      .toBe(true)

    // ── Edit our own message ─────────────────────────────────────────────────
    const ownMessage = messageListText(window, 'E2E hello world')
    await ownMessage.hover()
    // The message row is the closest ancestor with data-testid="message-<id>".
    const row = ownMessage.locator('xpath=ancestor::*[starts-with(@data-testid,"message-")][1]')
    const rowTestId = await row.getAttribute('data-testid')
    const postId = rowTestId!.replace('message-', '')
    await window.getByTestId(`edit-button-${postId}`).click()
    await window.getByTestId(`edit-input-${postId}`).fill('E2E edited message')
    await window.getByTestId(`save-edit-${postId}`).click()
    await expect(messageListText(window, 'E2E edited message')).toBeVisible()

    // ── Delete our message ───────────────────────────────────────────────────
    const editedMessage = messageListText(window, 'E2E edited message')
    await editedMessage.hover()
    const editedRow = editedMessage.locator(
      'xpath=ancestor::*[starts-with(@data-testid,"message-")][1]'
    )
    const editedId = (await editedRow.getAttribute('data-testid'))!.replace('message-', '')
    window.once('dialog', (d) => void d.accept())
    await window.getByTestId(`delete-button-${editedId}`).click()
    await expect(messageListText(window, 'E2E edited message')).toHaveCount(0)

    // ── Settings: toggle theme ───────────────────────────────────────────────
    await window.getByTestId('settings-button').click()
    await expect(window.getByTestId('settings-modal')).toBeVisible()
    await window.getByTestId('theme-light').click()
    await expect(window.locator('html')).not.toHaveClass(/dark/)

    // ── Logout ───────────────────────────────────────────────────────────────
    await window.getByTestId('logout-button').click()
    await expect(window.getByTestId('login-button')).toBeVisible()

    await app.close()
  })

  test('create a new team', async () => {
    const { app, window } = await launchMockApp()
    await window.getByTestId('login-button').click()
    await expect(window.getByTestId('chat-list')).toBeVisible()

    await window.getByTestId('new-team-button').click()
    await expect(window.getByTestId('create-team-modal')).toBeVisible()
    await window.getByTestId('team-name-input').fill('E2E Test Team')
    await window.getByTestId('team-description-input').fill('Created by E2E')
    await window.getByTestId('create-team-submit').click()
    await expect(window.getByTestId('create-team-modal')).toHaveCount(0)
    // The new team should appear in the sidebar.
    await expect(window.getByTestId('chat-list').getByText('E2E Test Team')).toBeVisible()

    await app.close()
  })

  test('search filters the chat list', async () => {
    const { app, window } = await launchMockApp()
    await window.getByTestId('login-button').click()
    await expect(window.getByTestId('chat-list')).toBeVisible()

    const search = window.getByTestId('search-input')
    await search.fill('Engineering')
    await expect(window.getByTestId('chat-row-team-general')).toBeVisible()

    await app.close()
  })
})
