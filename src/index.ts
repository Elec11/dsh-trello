import Schema from '@deepseek-ai/schemastery'
import { TrelloClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, MAX_PAGE_LIMIT } from './trello/client.js'
import { TrelloError, TrelloConfigError } from './trello/errors.js'
import { resolveTrelloConfig, resolvePassive, liveConfig } from './config.js'
import type { TrelloRuntime } from './tools/types.js'
import { buildBoardTools } from './tools/boards.js'
import { buildListTools } from './tools/lists.js'
import { buildCardTools } from './tools/cards.js'
import { buildCommentTools } from './tools/comments.js'

// The schemastery package only exposes a default export (the Schema constructor);
// alias it as `z` so the runtime calls stay identical to the spec.
const z = Schema

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  token: z.string().role('secret').volatile(),
  baseUrl: z.string().volatile(),
  timeoutMs: z.number().volatile(),
  // Read-only (passive) mode: when true, only the read-only tools are
  // registered, so the model cannot create, update, or comment.
  passive: z.boolean().volatile(),
})

export const name = 'tool-trello'
export const inject = ['tools']

export function apply(ctx: any, config: Record<string, unknown> = {}): void {
  const live = liveConfig(config)
  const passive = resolvePassive(live)
  let client: TrelloClient | null = null
  const runtime: TrelloRuntime = {
    getClient() {
      if (!client) client = new TrelloClient(resolveTrelloConfig(live))
      return client
    },
    signalOf(exec) {
      return exec?.signal
    },
  }
  const allTools = [
    ...buildBoardTools(runtime),
    ...buildListTools(runtime),
    ...buildCardTools(runtime),
    ...buildCommentTools(runtime),
  ]
  // Passive (read-only) mode registers only the read-only tools, so the model
  // cannot create, update, or comment. Full mode (the default) registers all.
  const tools = passive ? allTools.filter((tool) => tool.readOnly) : allTools
  for (const definition of tools) ctx.tools.register(definition)
}

export { resolveTrelloConfig, resolvePassive, liveConfig } from './config.js'
export { TrelloClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, MAX_PAGE_LIMIT } from './trello/client.js'
export { TrelloError, TrelloConfigError } from './trello/errors.js'
