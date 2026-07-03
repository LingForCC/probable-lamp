import { describe, expect, it } from 'vitest'
import {
  base64UrlEncode,
  createCodeChallenge,
  createCodeVerifier,
  timingSafeEqual,
  verifyPkcePair,
  UNRESERVED,
  type Sha256
} from '../../src/shared/client/pkce'

/**
 * A deterministic fake SHA-256 that just reverses the bytes — not a real hash,
 * but lets us assert the BASE64URL(SHA256(verifier)) shape with known vectors.
 */
const reverseSha256: Sha256 = async (input: Uint8Array) => {
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[input.length - 1 - i]
  return out
}

describe('base64UrlEncode', () => {
  it('produces URL-safe, padding-free output', () => {
    // RFC 4648 base64 of "foobar" -> "Zm9vYmFy"
    expect(base64UrlEncode(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy')
  })

  it('replaces + and / and strips = padding', () => {
    const bytes = new Uint8Array([255, 254, 253, 252, 251]) // produces + / and padding
    const encoded = base64UrlEncode(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe('createCodeVerifier', () => {
  it('returns a string of the requested length', () => {
    expect(createCodeVerifier(64).length).toBe(64)
  })

  it('only uses unreserved characters', () => {
    const v = createCodeVerifier(128)
    for (const ch of v) expect(UNRESERVED).toContain(ch)
  })

  it('rejects lengths outside 43–128', () => {
    expect(() => createCodeVerifier(10)).toThrow()
    expect(() => createCodeVerifier(200)).toThrow()
  })

  it('is deterministic given a seeded RNG', () => {
    const seq = [1, 2, 3, 4, 5]
    let i = 0
    const rng = () => seq[(i++) % seq.length]
    const a = createCodeVerifier(64, rng)
    i = 0
    const b = createCodeVerifier(64, rng)
    expect(a).toBe(b)
  })
})

describe('createCodeChallenge', () => {
  it('matches the real RFC 7636 S256 test vector', async () => {
    // From RFC 7636 §B (Worked example):
    //   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

    // Use the real Node crypto SHA-256.
    const { createHash } = await import('node:crypto')
    const realSha: Sha256 = (input) =>
      Promise.resolve(new Uint8Array(createHash('sha256').update(input).digest()))

    const challenge = await createCodeChallenge(verifier, realSha)
    expect(challenge).toBe(expected)
  })

  it('uses the injected hash function', async () => {
    const challenge = await createCodeChallenge('abc', reverseSha256)
    // reverseSha256 reverses "abc" -> "cba" -> base64url of "cba"
    expect(challenge).toBe(base64UrlEncode(new TextEncoder().encode('cba')))
  })
})

describe('verifyPkcePair / timingSafeEqual', () => {
  it('accepts a matching pair', async () => {
    const verifier = 'some-verifier-value-123'
    const challenge = await createCodeChallenge(verifier, reverseSha256)
    expect(await verifyPkcePair(verifier, challenge, reverseSha256)).toBe(true)
  })

  it('rejects a non-matching pair', async () => {
    expect(await verifyPkcePair('verifier-a', 'wrong-challenge', reverseSha256)).toBe(false)
  })

  it('timingSafeEqual handles equal and unequal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})
