/**
 * Accessor for the IPC bridge. In tests, `setRcmApi` swaps in a fake.
 */
import type { RcmApi } from '@shared/rcmApi'

let injected: RcmApi | null = null

export function getRcm(): RcmApi {
  if (injected) return injected
  // `window.rcm` is provided by the preload in the real app.
  return (window as unknown as { rcm: RcmApi }).rcm
}

export function setRcmApi(api: RcmApi | null): void {
  injected = api
}
