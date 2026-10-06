/**
 * Normalized error handling for the Trello client.
 *
 * Every message produced by this module is scrubbed with `redactSecrets`
 * before it is returned, so API keys and tokens never leak into error text.
 */

export type TLErrorCode =
  | 'not-configured'
  | 'invalid-request'
  | 'authentication'
  | 'permission-denied'
  | 'not-found'
  | 'rate-limited'
  | 'service-failure'
  | 'network'
  | 'timeout'
  | 'malformed-response'

export class TrelloError extends Error {
  readonly code: TLErrorCode
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(code: TLErrorCode, message: string, options?: { status?: number; retryAfterSeconds?: number }) {
    super(message)
    this.name = 'TrelloError'
    this.code = code
    this.status = options?.status
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}

/** A TrelloError whose code is always 'not-configured'. */
export class TrelloConfigError extends TrelloError {
  constructor(message?: string) {
    super('not-configured', message ?? 'Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.')
    this.name = 'TrelloConfigError'
  }
}

/**
 * Replace every non-empty secret value in `text` with `***`.
 * A no-op when the list is empty.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  if (secrets.length === 0) return text
  let result = text
  for (const secret of secrets) {
    if (!secret) continue
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'g'), '***')
  }
  return result
}

/**
 * Extract a safe, short human-readable detail from a Trello error body.
 * Trello error bodies look like `{"error": {"status": 400, "reason": "..."}}`
 * or `{"error": "..."}`. Returns undefined when no safe detail exists:
 * only non-empty strings of 200 characters or fewer that contain no
 * credentials are accepted. Never returns raw body objects.
 */
function extractBodyDetail(body: unknown, secrets: string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as Record<string, unknown>).error
  let candidate: unknown
  if (typeof error === 'string') {
    candidate = error
  } else if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.reason === 'string') candidate = record.reason
    else if (typeof record.message === 'string') candidate = record.message
  }
  if (typeof candidate !== 'string') return undefined
  const detail = candidate.trim()
  if (detail.length === 0 || detail.length > 200) return undefined
  for (const secret of secrets) {
    if (secret && detail.includes(secret)) return undefined
  }
  return detail
}

/**
 * Map an HTTP status to a normalized TrelloError.
 * The message is scrubbed with `redactSecrets` before being returned.
 */
export function errorFromStatus(
  status: number,
  resource: string,
  id: string | undefined,
  body: unknown,
  retryAfterHeader: string | null | undefined,
  secrets: string[],
): TrelloError {
  let code: TLErrorCode
  let message: string
  let retryAfterSeconds: number | undefined

  if (status === 400) {
    code = 'invalid-request'
    const detail = extractBodyDetail(body, secrets)
    message = detail
      ? `Trello API request failed: invalid request. (${detail})`
      : 'Trello API request failed: invalid request.'
  } else if (status === 401) {
    code = 'authentication'
    message = 'Trello authentication failed. Check TRELLO_API_KEY and TRELLO_TOKEN.'
  } else if (status === 403) {
    code = 'permission-denied'
    message = `Trello permission denied: the token may lack access to this ${resource}.`
  } else if (status === 404) {
    code = 'not-found'
    message = `Trello ${resource} not found: ${id ?? 'resource'}`
  } else if (status === 429) {
    code = 'rate-limited'
    message = 'Trello API request failed: rate limit exceeded.'
    if (retryAfterHeader) {
      const parsed = Number(retryAfterHeader.trim())
      if (Number.isInteger(parsed) && parsed > 0) {
        retryAfterSeconds = parsed
        message += ` Retry after ${parsed} seconds.`
      }
    }
  } else if (status >= 500 && status <= 599) {
    code = 'service-failure'
    message = `Trello service failure (HTTP ${status}).`
  } else {
    code = 'invalid-request'
    message = `Trello API request failed (HTTP ${status}).`
  }

  return new TrelloError(code, redactSecrets(message, secrets), { status, retryAfterSeconds })
}

/**
 * A sanitized one-line description of a network failure.
 * Never includes URLs or request details — only the error name.
 */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const safe = (error.name || 'error').toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (safe === 'typeerror') return 'network error: fetch failed'
    return safe ? `network error: ${safe}` : 'network error: fetch failed'
  }
  return 'network error: fetch failed'
}
