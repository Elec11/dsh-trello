import type {
  TrelloClientConfig,
  TrelloApiBoard,
  TrelloApiList,
  TrelloApiCard,
  TrelloApiComment,
  BoardSummary,
  BoardDetails,
  ListSummary,
  CardSummary,
  CardDetails,
  CommentConfirmation,
  PageOptions,
} from './types.js'
import { TrelloError, TrelloConfigError, errorFromStatus, redactSecrets, describeNetworkError } from './errors.js'

export const DEFAULT_BASE_URL = 'https://api.trello.com'
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_PAGE_LIMIT = 100

/** Clamp a caller-supplied page limit to 1..MAX_PAGE_LIMIT; undefined stays undefined. */
function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)))
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Map a raw Trello card to a CardSummary. Optional fields are omitted when
 * absent (never `undefined`) because the tool runtime rejects values that are
 * not lossless JSON — a present key with an `undefined` value fails the
 * snapshot. `null` is a valid JSON value and is kept.
 */
function toCardSummary(card: TrelloApiCard): CardSummary {
  const summary: CardSummary = {
    id: card.id,
    name: card.name,
    url: card.url ?? `https://trello.com/c/${card.id}`,
    listId: card.idList,
    boardId: card.idBoard,
    closed: card.closed,
  }
  if (card.due !== undefined) summary.due = card.due
  if (card.desc != null) summary.description = card.desc
  if (card.labelNames !== undefined) summary.labelNames = card.labelNames
  return summary
}

export class TrelloClient {
  readonly baseUrl: string
  readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  /** The two secrets, stored for redaction (and for building the auth query string) only. */
  private readonly secrets: string[]

  constructor(config: TrelloClientConfig) {
    const apiKey = (config.apiKey ?? '').trim()
    const token = (config.token ?? '').trim()
    if (!apiKey || !token) {
      throw new TrelloConfigError()
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = config.fetchImpl ?? fetch
    this.secrets = [apiKey, token]
  }

  /**
   * Log via console.debug with the `trello:` prefix, scrubbing any embedded
   * secrets. Callers pass only method + path (e.g. `GET /1/boards/abc`) —
   * never query strings.
   */
  private log(message: string): void {
    console.debug(`trello: ${redactSecrets(message, this.secrets)}`)
  }

  /**
   * Build the request URL. Trello's documented authentication mechanism is the
   * `key` and `token` query parameters (never an Authorization header);
   * URLSearchParams encodes them, and logs never include the query string.
   */
  private buildUrl(path: string, params: Record<string, string | number | boolean | undefined>): URL {
    const normalized = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}/1${normalized}`)
    url.searchParams.set('key', this.secrets[0])
    url.searchParams.set('token', this.secrets[1])
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value))
      }
    }
    return url
  }

  /** Map an endpoint path to the resource name and id used in error messages. */
  private describeTarget(path: string, body?: Record<string, unknown>): { resource: string; id?: string } {
    const segments = path.split('/').filter(Boolean)
    switch (segments[0]) {
      case 'members':
        return { resource: 'member' }
      case 'boards':
        return segments[1] ? { resource: 'board', id: segments[1] } : { resource: 'board' }
      case 'lists':
        return segments[1] ? { resource: 'list', id: segments[1] } : { resource: 'list' }
      case 'cards':
        if (segments[1]) return { resource: 'card', id: segments[1] }
        // POST /cards: a 404 means the target list (from the body) does not exist.
        return typeof body?.listId === 'string' ? { resource: 'list', id: body.listId } : { resource: 'list' }
      default:
        return { resource: 'board' }
    }
  }

  /** Core request. method + '/1' + path; GET/PUT params go to the query string, POST/PUT body is JSON. */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>
      body?: Record<string, unknown>
      signal?: AbortSignal
    },
  ): Promise<T> {
    const url = this.buildUrl(path, options?.params ?? {})
    this.log(`${method} /1${path}`)

    const init: RequestInit = { method }
    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body)
      init.headers = { 'Content-Type': 'application/json' }
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    init.signal =
      options?.signal instanceof AbortSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new TrelloError('timeout', `Trello API request failed: request timed out after ${this.timeoutMs}ms.`)
      }
      if (isAbortError(error)) {
        // Caller-initiated cancellation — propagate as-is.
        throw error
      }
      throw new TrelloError(
        'network',
        redactSecrets(`Trello API request failed: ${describeNetworkError(error)}`, this.secrets),
      )
    }

    const retryAfterHeader = response.headers.get('Retry-After')

    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204) {
        return undefined as T
      }
      const text = await response.text()
      try {
        return JSON.parse(text) as T
      } catch {
        throw new TrelloError('malformed-response', 'Trello API returned a malformed response.')
      }
    }

    const rawText = await response.text()
    let body: unknown
    try {
      body = rawText.length > 0 ? JSON.parse(rawText) : undefined
    } catch {
      body = rawText
    }
    const { resource, id } = this.describeTarget(path, options?.body)
    throw errorFromStatus(response.status, resource, id, body, retryAfterHeader, this.secrets)
  }

  async getBoards(options?: PageOptions & { signal?: AbortSignal }): Promise<BoardSummary[]> {
    const limit = clampLimit(options?.limit)
    const boards = await this.request<TrelloApiBoard[]>('GET', '/members/you/boards', {
      params: { limit },
      signal: options?.signal,
    })
    return (limit === undefined ? boards : boards.slice(0, limit)).map((board) => ({
      id: board.id,
      name: board.name,
      url: board.url ?? `https://trello.com/c/${board.id}`,
    }))
  }

  async getBoard(boardId: string, options?: { signal?: AbortSignal }): Promise<BoardDetails> {
    const board = await this.request<TrelloApiBoard>('GET', `/boards/${boardId}`, { signal: options?.signal })
    // Optional fields omitted when absent (never `undefined`) — see toCardSummary.
    const details: BoardDetails = {
      id: board.id,
      name: board.name,
      url: board.url ?? `https://trello.com/c/${board.id}`,
    }
    if (board.desc != null) details.desc = board.desc
    if (typeof board.closed === 'boolean') details.closed = board.closed
    if (board.labelName != null) details.labelName = board.labelName
    return details
  }

  async getLists(boardId: string, options?: PageOptions & { signal?: AbortSignal }): Promise<ListSummary[]> {
    const limit = clampLimit(options?.limit)
    const lists = await this.request<TrelloApiList[]>('GET', `/boards/${boardId}/lists`, {
      params: { limit },
      signal: options?.signal,
    })
    return (limit === undefined ? lists : lists.slice(0, limit)).map((list) => ({
      id: list.id,
      name: list.name,
      closed: list.closed,
      boardId: list.idBoard,
    }))
  }

  async getCards(listId: string, options?: PageOptions & { signal?: AbortSignal }): Promise<CardSummary[]> {
    const limit = clampLimit(options?.limit)
    const cards = await this.request<TrelloApiCard[]>('GET', `/lists/${listId}/cards`, {
      params: { limit },
      signal: options?.signal,
    })
    return (limit === undefined ? cards : cards.slice(0, limit)).map(toCardSummary)
  }

  async getCard(cardId: string, options?: { signal?: AbortSignal }): Promise<CardDetails> {
    const card = await this.request<TrelloApiCard>('GET', `/cards/${cardId}`, { signal: options?.signal })
    // Optional fields omitted when absent (never `undefined`) — see toCardSummary.
    const details: CardDetails = {
      ...toCardSummary(card),
    }
    if (card.position !== undefined) details.position = card.position
    if (card.idMembers !== undefined) details.idMembers = card.idMembers
    if (card.checkItem != null) details.checkItem = card.checkItem
    return details
  }

  async createCard(
    input: {
      listId: string
      name: string
      description?: string
      due?: string
      position?: number
      labelIds?: string[]
    },
    options?: { signal?: AbortSignal },
  ): Promise<CardSummary> {
    const body: Record<string, unknown> = { listId: input.listId, name: input.name }
    if (input.description !== undefined) body.description = input.description
    if (input.due !== undefined) body.due = input.due
    if (input.position !== undefined) body.position = input.position
    if (input.labelIds !== undefined) body.labelIds = input.labelIds
    const card = await this.request<TrelloApiCard>('POST', '/cards', { body, signal: options?.signal })
    return toCardSummary(card)
  }

  /**
   * Only provided (non-undefined) fields are sent — never overwrite fields the
   * caller did not provide. `due: null` clears the due date (sent as `due: null`).
   * `listId` moves the card to another list (sent as `idList`); `position` is the
   * ordering key within the list the card ends up in (the destination list when
   * `listId` is given, otherwise the card's current list).
   */
  async updateCard(
    cardId: string,
    patch: {
      name?: string
      description?: string
      due?: string | null
      closed?: boolean
      listId?: string
      position?: number
    },
    options?: { signal?: AbortSignal },
  ): Promise<CardSummary> {
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined) body.name = patch.name
    if (patch.description !== undefined) body.description = patch.description
    if (patch.due !== undefined) body.due = patch.due
    if (patch.closed !== undefined) body.closed = patch.closed
    if (patch.listId !== undefined) body.idList = patch.listId
    if (patch.position !== undefined) body.position = patch.position
    const card = await this.request<TrelloApiCard>('PUT', `/cards/${cardId}`, { body, signal: options?.signal })
    return toCardSummary(card)
  }

  async addComment(cardId: string, text: string, options?: { signal?: AbortSignal }): Promise<CommentConfirmation> {
    const comment = await this.request<TrelloApiComment>('POST', `/cards/${cardId}/actions/comments`, {
      body: { text },
      signal: options?.signal,
    })
    return {
      id: comment.id,
      cardId: comment.idCard,
      date: comment.date,
      text: comment.text,
    }
  }

  /** GET /1/members/you — throws TrelloError (authentication) when the credentials are rejected. */
  async verifyCredentials(options?: { signal?: AbortSignal }): Promise<void> {
    await this.request('GET', '/members/you', { signal: options?.signal })
  }
}
