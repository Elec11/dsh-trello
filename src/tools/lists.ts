import type { ToolDefinition, TrelloRuntime } from './types.js'
import { TOOL_TIMEOUT_MS } from './types.js'
import type { ListSummary } from '../trello/types.js'

export function buildListTools(runtime: TrelloRuntime): ToolDefinition[] {
  const listLists: ToolDefinition = {
    name: 'trello_list_lists',
    description:
      'List the lists on a Trello board. Returns each list\'s name, id, and closed status; there is no card count per list (Trello does not expose one), so use trello_list_cards to see a list\'s cards.',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Trello board id' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Maximum number of lists to return (default 50, max 100). There is no pagination, so a board with more than 100 lists cannot be fully listed.',
        },
      },
      required: ['boardId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          lists: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                closed: { type: 'boolean' },
                boardId: { type: 'string' },
              },
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value: { lists: ListSummary[] }) {
        const lists = value.lists
        const boardId = typeof _args?.boardId === 'string' ? _args.boardId : ''
        if (!Array.isArray(lists) || lists.length === 0) {
          return [{ type: 'text', text: `0 lists on board ${boardId}` }]
        }
        const lines = lists.map(
          (list) => `• ${list.name} (id: ${list.id})${list.closed ? ' [closed]' : ''}`,
        )
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    readOnly: true,
    async execute(args: { boardId: string; limit?: number }, exec) {
      const lists = await runtime.getClient().getLists(args.boardId, { limit: args.limit ?? 50, signal: runtime.signalOf(exec) })
      return { lists }
    },
  }

  return [listLists]
}
