import type { TrelloClient } from '../trello/client.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
    additionalProperties: false
  }
  output: {
    schema: any
    render: (args: any, value: any) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs: number
  /**
   * True for tools that only read Trello state. Passive (read-only) mode
   * registers only these tools, so the model cannot create, update, or comment.
   */
  readOnly: boolean
  execute: (args: any, exec: { signal?: AbortSignal; agent?: any }) => Promise<any>
}

export interface TrelloRuntime {
  /** Lazily build the client from the live config; throws TrelloConfigError when unconfigured. */
  getClient(): TrelloClient
  /** Pass the execution signal through to client calls. */
  signalOf(exec: { signal?: AbortSignal } | undefined): AbortSignal | undefined
}

export const TOOL_TIMEOUT_MS = 60000
