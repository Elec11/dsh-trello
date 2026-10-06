import type { ToolDefinition, TrelloRuntime } from './types.js'
import { TOOL_TIMEOUT_MS } from './types.js'
import type { BoardDetails, BoardSummary } from '../trello/types.js'

const limitParam = {
  type: 'integer' as const,
  minimum: 1,
  maximum: 100,
  description:
    'Maximum number of boards to return (default 50, max 100). There is no pagination, so an account with more than 100 boards cannot be fully listed.',
}

const boardItemSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
  },
}

export function buildBoardTools(runtime: TrelloRuntime): ToolDefinition[] {
  const listBoards: ToolDefinition = {
    name: 'trello_list_boards',
    description: 'List the Trello boards accessible to the configured account. Returns concise board id, name and url.',
    parameters: {
      type: 'object',
      properties: { limit: limitParam },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { boards: { type: 'array', items: boardItemSchema } },
        additionalProperties: false,
      },
      render(_args, value: { boards: BoardSummary[] }) {
        const boards = value.boards
        if (!Array.isArray(boards) || boards.length === 0) {
          return [{ type: 'text', text: '0 boards' }]
        }
        const lines = [`${boards.length} board(s)`]
        for (const board of boards) {
          lines.push(`• ${board.name} (id: ${board.id})`)
          lines.push(`  ${board.url}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args: { limit?: number }, exec) {
      const boards = await runtime.getClient().getBoards({ limit: args.limit ?? 50, signal: runtime.signalOf(exec) })
      return { boards }
    },
  }

  const getBoard: ToolDefinition = {
    name: 'trello_get_board',
    description: 'Get details of one Trello board by id.',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Trello board id' },
      },
      required: ['boardId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
          desc: { type: 'string' },
          closed: { type: 'boolean' },
          labelName: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value: BoardDetails) {
        const lines = [`Board: ${value.name}`, `url: ${value.url}`]
        if (value.desc) lines.push(`desc: ${value.desc}`)
        if (value.closed !== undefined) lines.push(`closed: ${value.closed}`)
        if (value.labelName) lines.push(`labelName: ${value.labelName}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args: { boardId: string }, exec) {
      return runtime.getClient().getBoard(args.boardId, { signal: runtime.signalOf(exec) })
    },
  }

  return [listBoards, getBoard]
}
