/**
 * Resolve the runtime config from environment variables (set via .env or the
 * dev shell). Provides safe defaults so the app always boots, defaulting to
 * MOCK mode when no credentials are present.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ServerConfig } from '../shared/types.js'

/**
 * Load a `.env` file into `process.env`.
 *
 * electron-vite (like Vite) only exposes `.env` vars that match its `VITE_*` /
 * `MAIN_VITE_*` prefixes, and only as build-time inlined values — it does NOT
 * populate `process.env` at runtime. Our `RC_*` vars therefore never reach the
 * main process unless we load them ourselves. Shell-provided env always wins
 * over `.env` (we only set vars that aren't already defined).
 */
function loadEnvFile(dir = process.cwd(), name = '.env'): void {
  const file = resolve(dir, name)
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!key || key in process.env) continue // shell env takes precedence
    let value = line.slice(eq + 1).trim()
    // Strip a single pair of surrounding quotes (single or double).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

// Load .env once at module import, before any readEnv() call.
loadEnvFile()

function readEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function resolveServer(value: string): 'sandbox' | 'production' {
  return value === 'production' ? 'production' : 'sandbox'
}

function resolveApiMode(value: string, hasJwt: boolean): 'mock' | 'real' {
  if (value === 'real') return 'real'
  if (value === 'mock') return 'mock'
  // Auto: fall back to mock when no JWT is configured.
  return hasJwt ? 'real' : 'mock'
}

export function loadConfig(): ServerConfig & {
  clientSecret?: string
} {
  const jwt = readEnv('RC_JWT')
  const server = resolveServer(readEnv('RC_SERVER', 'sandbox'))
  const apiMode = resolveApiMode(readEnv('RC_API_MODE'), Boolean(jwt))
  return {
    server,
    apiMode,
    clientId: readEnv('RC_CLIENT_ID') || undefined,
    clientSecret: readEnv('RC_CLIENT_SECRET') || undefined,
    jwt: jwt || undefined
  }
}
