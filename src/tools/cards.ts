import type { ToolDefinition, TrelloRuntime } from './types.js'
import { TOOL_TIMEOUT_MS } from './types.js'
import type { CardDetails, CardSummary } from '../trello/types.js'

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const cardItemSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    listId: { type: 'string' },
    boardId: { type: 'string' },
    closed: { type: 'boolean' },
    due: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    description: { type: 'string' },
    labelNames: { type: 'array', items: { type: 'string' } },
  },
}

function renderCards(value: CardSummary[], emptyLabel: string): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ type: 'text', text: emptyLabel }]
  }
  const blocks = value.map((card) => {
    const lines = [`• ${card.name} (id: ${card.id})${card.closed ? ' [closed]' : ''}`]
    if (card.due) lines.push(`  due: ${card.due}`)
    if (card.labelNames && card.labelNames.length > 0) lines.push(`  labels: ${card.labelNames.join(', ')}`)
    return lines.join('\n')
  })
  return [{ type: 'text', text: blocks.join('\n') }]
}

export function buildCardTools(runtime: TrelloRuntime): ToolDefinition[] {
  const listCards: ToolDefinition = {
    name: 'trello_list_cards',
    description:
      'List the cards in a Trello list. Returns each card\'s name, id, closed status, due date, and labels (due/labels only when set); use trello_get_card for description and full details. There is no board-level card listing — to find a card on a board, list the board\'s lists first (trello_list_lists), then list each list\'s cards.',
    parameters: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'Trello list id' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Maximum number of cards to return (default 50, max 100). There is no pagination, so a list with more than 100 cards cannot be fully listed.',
        },
      },
      required: ['listId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { cards: { type: 'array', items: cardItemSchema } },
        additionalProperties: false,
      },
      render(_args, value: { cards: CardSummary[] }) {
        const listId = typeof _args?.listId === 'string' ? _args.listId : ''
        return renderCards(value.cards, `0 cards in list ${listId}`)
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    readOnly: true,
    async execute(args: { listId: string; limit?: number }, exec) {
      const cards = await runtime.getClient().getCards(args.listId, { limit: args.limit ?? 50, signal: runtime.signalOf(exec) })
      return { cards }
    },
  }

  const getCard: ToolDefinition = {
    name: 'trello_get_card',
    description:
      'Get details of one Trello card by id. Always returns name, id, url, listId, boardId, and closed; due, description, labels, position, and checklist progress are included only when the card has them.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Trello card id' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...cardItemSchema.properties,
          position: { type: 'number' },
          idMembers: { type: 'array', items: { type: 'string' } },
          checkItem: {
            type: 'object',
            properties: { complete: { type: 'number' }, total: { type: 'number' } },
          },
        },
        additionalProperties: false,
      },
      render(_args, value: CardDetails) {
        const lines = [
          `name: ${value.name}`,
          `id: ${value.id}`,
          `url: ${value.url}`,
          `listId: ${value.listId}`,
          `boardId: ${value.boardId}`,
          `closed: ${value.closed}`,
        ]
        if (value.due) lines.push(`due: ${value.due}`)
        if (value.description) lines.push(`description: ${truncate(value.description, 500)}`)
        if (value.labelNames && value.labelNames.length > 0) lines.push(`labels: ${value.labelNames.join(', ')}`)
        if (value.position !== undefined) lines.push(`position: ${value.position}`)
        if (value.checkItem) lines.push(`checklist: ${value.checkItem.complete}/${value.checkItem.total}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    readOnly: true,
    async execute(args: { cardId: string }, exec) {
      return runtime.getClient().getCard(args.cardId, { signal: runtime.signalOf(exec) })
    },
  }

  const createCard: ToolDefinition = {
    name: 'trello_create_card',
    description: 'Create a new card in a Trello list.',
    parameters: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'Trello list id to create the card in' },
        name: { type: 'string', description: 'Card title' },
        description: { type: 'string', description: 'Card description (Markdown)' },
        due: { type: 'string', description: 'ISO 8601 due date, e.g. 2026-10-06T18:00:00Z' },
        position: {
          type: 'number',
          description:
            'Floating-point ordering key within the list; omit to append to the end. Lower = earlier.',
        },
        labelIds: { type: 'array', items: { type: 'string' }, description: 'Trello label ids to attach' },
      },
      required: ['listId', 'name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: cardItemSchema.properties, additionalProperties: false },
      render(_args, value: CardSummary) {
        return [{ type: 'text', text: `Card "${value.name}" (id: ${value.id}) — ${value.url}` }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    readOnly: false,
    async execute(args: { listId: string; name: string; description?: string; due?: string; position?: number; labelIds?: string[] }, exec) {
      const input: { listId: string; name: string; description?: string; due?: string; position?: number; labelIds?: string[] } = {
        listId: args.listId,
        name: args.name,
      }
      if (args.description !== undefined) input.description = args.description
      if (args.due !== undefined) input.due = args.due
      if (args.position !== undefined) input.position = args.position
      if (args.labelIds !== undefined) input.labelIds = args.labelIds
      return runtime.getClient().createCard(input, { signal: runtime.signalOf(exec) })
    },
  }

  const updateCard: ToolDefinition = {
    name: 'trello_update_card',
    description:
      'Update an existing Trello card. Only the fields you provide are changed; fields you omit are left untouched. Pass listId to move the card to another list (omit to keep the current list).',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Trello card id' },
        name: { type: 'string', description: 'New card title' },
        description: { type: 'string', description: 'New card description (Markdown)' },
        due: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'New ISO 8601 due date; pass null to clear the due date',
        },
        closed: { type: 'boolean', description: 'Mark the card closed (true) or reopen it (false)' },
        listId: {
          type: 'string',
          description:
            'Destination Trello list id — moves the card to this list. Omit to keep the card in its current list.',
        },
        position: {
          type: 'number',
          description:
            'New floating-point ordering key within the list the card ends up in (the destination list if listId is given, otherwise the current list); omit to keep its position (append to the end when moving). Lower = earlier.',
        },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: cardItemSchema.properties, additionalProperties: false },
      render(_args, value: CardSummary) {
        const moved = typeof _args?.listId === 'string' ? `\nmoved to list ${_args.listId}` : ''
        return [{ type: 'text', text: `Card "${value.name}" (id: ${value.id}) — ${value.url}${moved}` }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    readOnly: false,
    async execute(args: { cardId: string; name?: string; description?: string; due?: string | null; closed?: boolean; listId?: string; position?: number }, exec) {
      const patch: { name?: string; description?: string; due?: string | null; closed?: boolean; listId?: string; position?: number } = {}
      if (args.name !== undefined) patch.name = args.name
      if (args.description !== undefined) patch.description = args.description
      if (args.due !== undefined) patch.due = args.due
      if (args.closed !== undefined) patch.closed = args.closed
      if (args.listId !== undefined) patch.listId = args.listId
      if (args.position !== undefined) patch.position = args.position
      return runtime.getClient().updateCard(args.cardId, patch, { signal: runtime.signalOf(exec) })
    },
  }

  return [listCards, getCard, createCard, updateCard]
}
