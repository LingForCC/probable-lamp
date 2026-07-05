import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Real-persistence tests for AppStore.
 *
 * Uses the actual `electron-store` (ESM, v10) writing to a fresh temp dir per
 * test, so we exercise the real JSON get/set path that production relies on —
 * not a fake. Only `electron`'s `safeStorage` is mocked (it's a native API used
 * for token encryption, unrelated to read-state plaintext persistence; the
 * module imports it at load time).
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))
import { AppStore } from '../../src/main/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AppStore read-state persistence', () => {
  it('returns an empty map when nothing has been persisted', () => {
    const store = new AppStore(dir)
    expect(store.getReadStates()).toEqual({})
  })

  it('persists a per-chat watermark and reads it back', () => {
    const store = new AppStore(dir)
    store.setReadState('c1', '2024-01-01T00:00:00Z')
    store.setReadState('c2', '2024-02-01T12:30:00Z')
    expect(store.getReadStates()).toEqual({
      c1: '2024-01-01T00:00:00Z',
      c2: '2024-02-01T12:30:00Z'
    })
  })

  it('overwrites an existing chat watermark without affecting others', () => {
    const store = new AppStore(dir)
    store.setReadState('c1', '2024-01-01T00:00:00Z')
    store.setReadState('c1', '2024-09-01T00:00:00Z') // advance
    expect(store.getReadStates()['c1']).toBe('2024-09-01T00:00:00Z')
    expect(Object.keys(store.getReadStates())).toEqual(['c1'])
  })

  it('survives a restart (a new AppStore instance reads the same file)', () => {
    const store = new AppStore(dir)
    store.setReadState('c1', '2024-01-01T00:00:00Z')
    store.setReadState('c2', '2024-02-01T00:00:00Z')
    // Simulate app restart: new instance, same cwd.
    const restarted = new AppStore(dir)
    expect(restarted.getReadStates()).toEqual({
      c1: '2024-01-01T00:00:00Z',
      c2: '2024-02-01T00:00:00Z'
    })
  })

  it('isolates state per cwd (independent temp dirs do not share data)', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'rc-store-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'rc-store-b-'))
    try {
      const a = new AppStore(dirA)
      const b = new AppStore(dirB)
      a.setReadState('c1', '2024-01-01T00:00:00Z')
      expect(b.getReadStates()).toEqual({})
      expect(a.getReadStates()['c1']).toBe('2024-01-01T00:00:00Z')
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('AppStore firstStartedAt', () => {
  it('is null until markFirstStart is called', () => {
    const store = new AppStore(dir)
    expect(store.getFirstStartedAt()).toBeNull()
  })

  it('markFirstStart records and returns the timestamp', () => {
    const store = new AppStore(dir)
    const ts = store.markFirstStart('2024-01-01T00:00:00Z')
    expect(ts).toBe('2024-01-01T00:00:00Z')
    expect(store.getFirstStartedAt()).toBe('2024-01-01T00:00:00Z')
  })

  it('markFirstStart is idempotent: a second call returns the original value', () => {
    const store = new AppStore(dir)
    store.markFirstStart('2024-01-01T00:00:00Z')
    // A later boot tries to record "now"; the first value must win.
    const second = store.markFirstStart('2025-06-01T12:00:00Z')
    expect(second).toBe('2024-01-01T00:00:00Z')
    expect(store.getFirstStartedAt()).toBe('2024-01-01T00:00:00Z')
  })

  it('survives a restart (new instance reads the same recorded value)', () => {
    const store = new AppStore(dir)
    store.markFirstStart('2024-01-01T00:00:00Z')
    const restarted = new AppStore(dir)
    expect(restarted.getFirstStartedAt()).toBe('2024-01-01T00:00:00Z')
    // And re-marking on the restarted instance is a no-op.
    expect(restarted.markFirstStart('2030-01-01T00:00:00Z')).toBe('2024-01-01T00:00:00Z')
  })
})
