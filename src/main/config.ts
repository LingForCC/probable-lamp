/**
 * Resolve the runtime config from environment variables (set via .env or the
 * dev shell). Provides safe defaults so the app always boots, defaulting to
 * MOCK mode when no credentials are present.
 */
import type { ServerConfig } from '../shared/types.js'

function readEnv(name: string, fallback = ''): string {
  // process.env is populated by electron-vite from .env files for the main process.
  return process.env[name] ?? fallback
}

function resolveServer(value: string): 'sandbox' | 'production' {
  return value === 'production' ? 'production' : 'sandbox'
}

function resolveApiMode(value: string, hasClientId: boolean): 'mock' | 'real' {
  if (value === 'real') return 'real'
  if (value === 'mock') return 'mock'
  // Auto: fall back to mock when no client id is configured.
  return hasClientId ? 'real' : 'mock'
}

export function loadConfig(): ServerConfig & {
  clientSecret?: string
} {
  const clientId = readEnv('RC_CLIENT_ID')
  const server = resolveServer(readEnv('RC_SERVER', 'sandbox'))
  const apiMode = resolveApiMode(readEnv('RC_API_MODE'), Boolean(clientId))
  return {
    server,
    apiMode,
    clientId: clientId || undefined,
    clientSecret: readEnv('RC_CLIENT_SECRET') || undefined,
    redirectUri: readEnv('RC_REDIRECT_URI', 'http://localhost:4173/auth/callback')
  }
}
