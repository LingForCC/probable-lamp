import type { RcmApi } from '@shared/rcmApi'

declare global {
  interface Window {
    rcm: RcmApi
  }
}

export {}
