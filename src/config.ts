import { TrelloConfigError } from './trello/errors.js'
import type { TrelloClientConfig } from './trello/types.js'

/** Unwrap volatile config references: values with a .get() function are read live; plain values pass through. */
export function liveConfig(config: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(config, {
    get(target, prop) {
      const value = (target as Record<string, unknown>)[prop as string]
      if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
        return (value as { get(): unknown }).get()
      }
      return value
    },
  })
}

function credential(liveValue: unknown, envName: string): string | undefined {
  if (typeof liveValue === 'string' && liveValue.trim() !== '') return liveValue
  const env = process.env[envName]
  if (env !== undefined && env.trim() !== '') return env
  return undefined
}

function optionalString(liveValue: unknown): string | undefined {
  return typeof liveValue === 'string' && liveValue.trim() !== '' ? liveValue : undefined
}

function optionalPositiveNumber(liveValue: unknown): number | undefined {
  if (liveValue === undefined || liveValue === null) return undefined
  if (typeof liveValue !== 'number' || !Number.isFinite(liveValue) || liveValue <= 0) {
    throw new TrelloConfigError('timeoutMs must be a positive number.')
  }
  return liveValue
}

/**
 * Resolve effective Trello credentials.
 * Priority per field: live config value (non-empty string/number) → environment variable.
 *   apiKey  → config.apiKey  → process.env.TRELLO_API_KEY
 *   token   → config.token   → process.env.TRELLO_TOKEN
 *   baseUrl → config.baseUrl  (optional; no env fallback)
 *   timeoutMs → config.timeoutMs (optional; must be a positive number when present)
 * Throws TrelloConfigError with the EXACT message:
 *   'Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.'
 * when either credential is still missing. Never include credential values in any thrown message.
 */
export function resolveTrelloConfig(live: Record<string, unknown>): TrelloClientConfig {
  const apiKey = credential(live.apiKey, 'TRELLO_API_KEY')
  const token = credential(live.token, 'TRELLO_TOKEN')
  if (!apiKey || !token) {
    throw new TrelloConfigError('Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.')
  }
  const config: TrelloClientConfig = { apiKey, token }
  const baseUrl = optionalString(live.baseUrl)
  if (baseUrl !== undefined) config.baseUrl = baseUrl
  const timeoutMs = optionalPositiveNumber(live.timeoutMs)
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
  return config
}
