/**
 * Node-backed crypto helpers for the Electron main process. Wired into the
 * RingCentral client (sha256 for PKCE) and the pkce base64 encoder.
 */
import { createHash } from 'node:crypto'
import type { Sha256 } from '../shared/client/pkce.js'
import { setBase64Encoder } from '../shared/client/pkce.js'

export const nodeSha256: Sha256 = async (input: Uint8Array): Promise<Uint8Array> => {
  return new Uint8Array(createHash('sha256').update(input).digest())
}

/** Node Buffer-backed base64, used by pkce in the main process. */
export const nodeBase64Encode = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('base64')
}

/** Install the Node base64 encoder so pkce.base64UrlEncode works in main. */
export function installNodeCrypto(): void {
  setBase64Encoder(nodeBase64Encode)
}
