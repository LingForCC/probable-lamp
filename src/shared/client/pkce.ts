/**
 * OAuth 2.0 PKCE helpers (RFC 7636).
 *
 * Pure, crypto-agnostic: a `Sha256` implementation is injected so this can be
 * unit-tested with a fake hash and used in both Node (crypto) and browser
 * (WebCrypto) environments.
 */

/**
 * Hash function interface — returns raw bytes. Injected so the module is
 * environment-agnostic and testable with a deterministic fake.
 */
export interface Sha256 {
  (input: Uint8Array): Promise<Uint8Array>
}

/**
 * Base64url encode without padding (RFC 7636 §4.2 / RFC 4648 §5).
 *
 * Uses the platform `btoa` when available (browser + Electron renderer). The
 * main process can inject a Node-backed `base64Encode` via {@link setBase64Encoder}.
 */
export type Base64Encoder = (bytes: Uint8Array) => string

let activeBase64Encoder: Base64Encoder | null = null

/** Inject a base64 encoder (e.g. Buffer-based) in Node contexts. */
export function setBase64Encoder(enc: Base64Encoder | null): void {
  activeBase64Encoder = enc
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let b64: string
  if (activeBase64Encoder) {
    b64 = activeBase64Encoder(bytes)
  } else if (typeof btoa === 'function') {
    let str = ''
    for (const byte of bytes) str += String.fromCharCode(byte)
    b64 = btoa(str)
  } else {
    throw new Error('No base64 encoder available. Call setBase64Encoder() in Node.')
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * RFC 6749 unreserved characters for the verifier.
 */
export const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/**
 * Generate a random PKCE code_verifier of the given length (43–128).
 * A `randomByte` function is injected so tests can be deterministic.
 */
export function createCodeVerifier(
  length = 96,
  randomByte: () => number = defaultRandomByte
): string {
  if (length < 43 || length > 128) {
    throw new Error(`code_verifier length must be 43–128, got ${length}`)
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += UNRESERVED[randomByte() % UNRESERVED.length]
  }
  return out
}

/**
 * Compute the S256 code_challenge from a verifier:
 *   challenge = BASE64URL(SHA256(verifier))
 * Uses the injected hash; see {@link Sha256}.
 */
export async function createCodeChallenge(
  verifier: string,
  sha256: Sha256
): Promise<string> {
  const bytes = new TextEncoder().encode(verifier)
  const digest = await sha256(bytes)
  return base64UrlEncode(digest)
}

/**
 * Verify a (verifier, challenge) pair against the S256 method. Useful for tests.
 */
export async function verifyPkcePair(
  verifier: string,
  challenge: string,
  sha256: Sha256
): Promise<boolean> {
  const expected = await createCodeChallenge(verifier, sha256)
  return timingSafeEqual(expected, challenge)
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Default RNG: Node crypto in main, Math.random fallback elsewhere. */
function defaultRandomByte(): number {
  return Math.floor(Math.random() * 256)
}
