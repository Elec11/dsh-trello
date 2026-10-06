// --- Raw Trello API objects (subsets; the API returns more fields — we ignore extras) ---
export interface TrelloApiBoard {
  id: string
  name: string
  url?: string
  closed?: boolean
  desc?: string
  labelName?: string
  preferredSize?: number
  [key: string]: unknown
}
export interface TrelloApiList {
  id: string
  name: string
  closed: boolean
  pos: number
  idBoard: string
  [key: string]: unknown
}
export interface TrelloApiCard {
  id: string
  name: string
  desc?: string | null
  url?: string
  idList: string
  idBoard: string
  closed: boolean
  due?: string | null
  position?: number
  labelNames?: string[]
  labels?: { id: string; name: string; color: string }[]
  idMembers?: string[]
  checkItem?: { complete: number; total: number }
  [key: string]: unknown
}
export interface TrelloApiComment {
  id: string
  text: string
  date: string
  idCard: string
  [key: string]: unknown
}

// --- Model-facing summary shapes (what tools return — keep them small) ---
export interface BoardSummary { id: string; name: string; url: string }
export interface BoardDetails extends BoardSummary { desc?: string; closed?: boolean; labelName?: string }
export interface ListSummary { id: string; name: string; closed: boolean; boardId: string }
export interface CardSummary {
  id: string
  name: string
  url: string
  listId: string
  boardId: string
  closed: boolean
  due?: string | null
  description?: string
  labelNames?: string[]
}
export interface CardDetails extends CardSummary {
  position?: number
  idMembers?: string[]
  checkItem?: { complete: number; total: number }
}
export interface CommentConfirmation { id: string; cardId: string; date: string; text: string }

// --- Client configuration ---
export interface TrelloClientConfig {
  apiKey: string
  token: string
  /** Default https://api.trello.com — overridable for testing. */
  baseUrl?: string
  /** Default 30000 ms. */
  timeoutMs?: number
  /** Injectable fetch implementation for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}
export interface PageOptions { limit?: number }
