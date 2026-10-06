import type { ToolDefinition, TrelloRuntime } from './types.js'
import { TOOL_TIMEOUT_MS } from './types.js'
import type { CommentConfirmation } from '../trello/types.js'

export function buildCommentTools(runtime: TrelloRuntime): ToolDefinition[] {
  const addComment: ToolDefinition = {
    name: 'trello_add_comment',
    description: 'Add a comment to a Trello card.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Trello card id' },
        text: { type: 'string', description: 'Comment text (Markdown)' },
      },
      required: ['cardId', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          cardId: { type: 'string' },
          date: { type: 'string' },
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value: CommentConfirmation) {
        return [{ type: 'text', text: `Comment ${value.id} added to card ${value.cardId} at ${value.date}:\n${value.text}` }]
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args: { cardId: string; text: string }, exec) {
      const text = String(args.text)
      if (text.trim() === '') {
        throw new Error('text must not be empty')
      }
      return runtime.getClient().addComment(args.cardId, text, { signal: runtime.signalOf(exec) })
    },
  }

  return [addComment]
}
