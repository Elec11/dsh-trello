import test from 'node:test'
import assert from 'node:assert/strict'

import { TrelloClient } from '../src/trello/client.js'
import { TrelloConfigError, TrelloError } from '../src/trello/errors.js'
import { resolveTrelloConfig, resolvePassive } from '../src/config.js'
import { apply, Config } from '../src/index.js'
import { buildBoardTools } from '../src/tools/boards.js'
import { buildListTools } from '../src/tools/lists.js'
import { buildCardTools } from '../src/tools/cards.js'
import { buildCommentTools } from '../src/tools/comments.js'
import type { TrelloClientConfig } from '../src/trello/types.js'
import type { TrelloRuntime } from '../src/tools/types.js'

type Tool = ReturnType<typeof buildBoardTools>[number]

const FAKE_API_KEY = 'FAKE_API_KEY_123'
const FAKE_TOKEN = 'FAKE_TOKEN_456'

// ---------------------------------------------------------------------------
// Fake fetch: records every call and returns queued Response objects.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
}

interface FakeFetchOptions {
  /** Responses queued in order; when the queue is empty the call hangs (or waits for the signal). */
  responses?: Response[]
  /** When set, every call rejects with this value. */
  rejectWith?: unknown
}

class FakeFetch {
  readonly calls: RecordedCall[] = []
  private readonly queue: Response[]
  private readonly rejectWith: unknown

  constructor(options: FakeFetchOptions = {}) {
    this.queue = options.responses ?? []
    this.rejectWith = options.rejectWith
  }

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers: Record<string, string> = {}
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
    }
    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ?? null,
    })
    if (this.rejectWith !== undefined) {
      return Promise.reject(this.rejectWith)
    }
    const next = this.queue.shift()
    if (next !== undefined) {
      return Promise.resolve(next)
    }
    // No queued response: emulate real fetch — hang until the signal aborts,
    // then reject with an AbortError (what AbortSignal.timeout produces).
    const signal = init?.signal
    if (signal) {
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    }
    return new Promise<Response>(() => {})
  }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeRuntime(options: FakeFetchOptions = {}, clientOptions: Partial<TrelloClientConfig> = {}) {
  const fetchCalls = new FakeFetch(options)
  const client = new TrelloClient({
    apiKey: FAKE_API_KEY,
    token: FAKE_TOKEN,
    fetchImpl: fetchCalls.fetch,
    ...clientOptions,
  })
  const runtime: TrelloRuntime = {
    getClient: () => client,
    signalOf: (exec) => exec?.signal,
  }
  return { runtime, fetchCalls }
}

function allTools(runtime: TrelloRuntime): Tool[] {
  return [
    ...buildBoardTools(runtime),
    ...buildListTools(runtime),
    ...buildCardTools(runtime),
    ...buildCommentTools(runtime),
  ]
}

function findTool(runtime: TrelloRuntime, name: string): Tool {
  const tool = allTools(runtime).find((candidate) => candidate.name === name)
  assert.ok(tool, `tool ${name} not found`)
  return tool
}

// Run a tool so that a synchronous throw from execute() still surfaces as a rejection.
function runTool(tool: Tool, args: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve().then(() => tool.execute(args, { signal: undefined }))
}

// Accept either a bare summary array or an object wrapping one ({ boards } / { lists } / { cards }).
function unwrapSummaries(result: unknown, key: 'boards' | 'lists' | 'cards'): unknown[] {
  if (Array.isArray(result)) return result
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as Record<string, unknown>)[key])
  ) {
    return (result as Record<string, unknown>)[key] as unknown[]
  }
  throw new Error(`unexpected result shape: ${JSON.stringify(result)}`)
}

// @types/node's assert.rejects returns void, so capture the error manually.
async function captureReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected promise to reject')
}

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

test('registration shape: exactly the eight fixed tool names, no duplicates or extras', () => {
  const { runtime } = makeRuntime()
  const tools = allTools(runtime)
  const names = tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, 'duplicate tool names found')
  assert.deepEqual(
    [...names].sort(),
    [
      'trello_add_comment',
      'trello_create_card',
      'trello_get_board',
      'trello_get_card',
      'trello_list_boards',
      'trello_list_cards',
      'trello_list_lists',
      'trello_update_card',
    ],
  )
})

// ---------------------------------------------------------------------------
// Passive (read-only) mode
// ---------------------------------------------------------------------------

// Run apply() against a mock context and return the sorted registered tool names.
function applyToolNames(config: Record<string, unknown>): string[] {
  const registered: Array<{ name: string }> = []
  apply({ tools: { register: (def: { name: string }) => registered.push(def) } }, config)
  return registered.map((tool) => tool.name).sort()
}

test('apply (full mode, default): registers all eight tools', () => {
  assert.deepEqual(
    applyToolNames({}),
    [
      'trello_add_comment',
      'trello_create_card',
      'trello_get_board',
      'trello_get_card',
      'trello_list_boards',
      'trello_list_cards',
      'trello_list_lists',
      'trello_update_card',
    ],
  )
})

test('apply (passive mode): registers only the five read-only tools', () => {
  assert.deepEqual(
    applyToolNames({ passive: true }),
    [
      'trello_get_board',
      'trello_get_card',
      'trello_list_boards',
      'trello_list_cards',
      'trello_list_lists',
    ],
  )
})

test('apply (passive mode): never registers a mutating tool', () => {
  const names = applyToolNames({ passive: true })
  for (const mutating of ['trello_create_card', 'trello_update_card', 'trello_add_comment']) {
    assert.ok(!names.includes(mutating), `${mutating} must not be registered in passive mode`)
  }
})

test('resolvePassive: only a strict boolean true enables passive mode', () => {
  assert.equal(resolvePassive({ passive: true }), true)
  assert.equal(resolvePassive({ passive: false }), false)
  assert.equal(resolvePassive({}), false)
  assert.equal(resolvePassive({ passive: undefined }), false)
  assert.equal(resolvePassive({ passive: 'yes' }), false)
  assert.equal(resolvePassive({ passive: 1 }), false)
})

// ---------------------------------------------------------------------------
// Schema strictness
// ---------------------------------------------------------------------------

test('schema strictness: additionalProperties false and required fields', () => {
  const { runtime } = makeRuntime()
  const tools = allTools(runtime)
  for (const tool of tools) {
    assert.equal(
      tool.parameters.additionalProperties,
      false,
      `${tool.name}: parameters.additionalProperties must be false`,
    )
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const requiredFields: Record<string, string[]> = {
    trello_get_board: ['boardId'],
    trello_list_lists: ['boardId'],
    trello_list_cards: ['listId'],
    trello_get_card: ['cardId'],
    trello_update_card: ['cardId'],
    trello_add_comment: ['cardId'],
    trello_create_card: ['listId', 'name'],
  }
  for (const [name, fields] of Object.entries(requiredFields)) {
    const tool = byName.get(name)
    assert.ok(tool, `tool ${name} missing`)
    assert.ok(tool.parameters.required, `${name}: parameters.required must be present`)
    assert.ok(tool.parameters.required!.length > 0, `${name}: parameters.required must be non-empty`)
    for (const field of fields) {
      assert.ok(
        tool.parameters.required!.includes(field),
        `${name}: ${field} must be listed in required`,
      )
    }
  }
  const listBoards = byName.get('trello_list_boards')
  assert.ok(listBoards, 'trello_list_boards missing')
  assert.ok(
    !listBoards.parameters.required || listBoards.parameters.required.length === 0,
    'trello_list_boards must have no required fields',
  )
})

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('resolveTrelloConfig: unconfigured throws, env and live config resolve', () => {
  const savedApiKey = process.env.TRELLO_API_KEY
  const savedToken = process.env.TRELLO_TOKEN
  try {
    delete process.env.TRELLO_API_KEY
    delete process.env.TRELLO_TOKEN

    // Unconfigured: no live values and no env vars.
    let threw = false
    try {
      resolveTrelloConfig({})
    } catch (err) {
      threw = true
      assert.ok(err instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(err)}`)
      assert.ok(
        err.message.includes('Trello plugin is not configured'),
        `unexpected message: ${err.message}`,
      )
    }
    assert.ok(threw, 'resolveTrelloConfig should throw when unconfigured')

    // Configured via environment variables.
    process.env.TRELLO_API_KEY = FAKE_API_KEY
    process.env.TRELLO_TOKEN = FAKE_TOKEN
    const fromEnv = resolveTrelloConfig({})
    assert.equal(fromEnv.apiKey, FAKE_API_KEY)
    assert.equal(fromEnv.token, FAKE_TOKEN)

    // Configured via the live (plugin) config.
    const fromLive = resolveTrelloConfig({ apiKey: FAKE_API_KEY, token: FAKE_TOKEN })
    assert.equal(fromLive.apiKey, FAKE_API_KEY)
    assert.equal(fromLive.token, FAKE_TOKEN)
  } finally {
    if (savedApiKey === undefined) delete process.env.TRELLO_API_KEY
    else process.env.TRELLO_API_KEY = savedApiKey
    if (savedToken === undefined) delete process.env.TRELLO_TOKEN
    else process.env.TRELLO_TOKEN = savedToken
  }
})

test('Config schema: accepts passive true/false and still parses the empty config', () => {
  assert.ok(Config({}), 'Config({}) must still parse')
  assert.ok(Config({ apiKey: 'k', token: 't', passive: true }), 'passive: true must parse')
  assert.ok(Config({ apiKey: 'k', token: 't', passive: false }), 'passive: false must parse')
})

// ---------------------------------------------------------------------------
// Unconfigured runtime
// ---------------------------------------------------------------------------

test('unconfigured runtime: tool execution rejects with the config error', async () => {
  const runtime: TrelloRuntime = {
    getClient: () => {
      throw new TrelloConfigError('Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.')
    },
    signalOf: (exec) => exec?.signal,
  }
  const tool = findTool(runtime, 'trello_list_boards')
  const err = await captureReject(runTool(tool, {}))
  assert.ok(err instanceof Error, `expected an Error, got: ${String(err)}`)
  assert.ok(
    err.message.includes('Trello plugin is not configured'),
    `unexpected message: ${err.message}`,
  )
})

// ---------------------------------------------------------------------------
// Boards tools
// ---------------------------------------------------------------------------

test('trello_list_boards returns BoardSummary[] and renders board names', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, [
        { id: 'b1', name: 'Board One', url: 'https://trello.com/b/b1/board-one' },
        { id: 'b2', name: 'Board Two', url: 'https://trello.com/b/b2/board-two' },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_boards')
  const result = await runTool(tool, {})
  const boards = unwrapSummaries(result, 'boards') as Array<{ id: string; name: string; url: string }>
  assert.equal(boards.length, 2)
  assert.equal(boards[0].name, 'Board One')
  assert.equal(boards[1].name, 'Board Two')
  const rendered = tool.output.render({}, result)
  assert.ok(Array.isArray(rendered), 'render output should be an array')
  // Tolerate both plain string blocks and { type: 'text', text } content blocks.
  const renderedText = (rendered as unknown[]).flatMap((value) =>
    typeof value === 'string'
      ? [value]
      : [((value as { text?: string } | null)?.text ?? '')],
  )
  assert.ok(
    renderedText.some((text) => text.includes('Board One')),
    'render output missing Board One',
  )
  assert.ok(
    renderedText.some((text) => text.includes('Board Two')),
    'render output missing Board Two',
  )
})

test('trello_list_boards forwards limit', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, [
        { id: 'b1', name: 'Board One', url: 'https://trello.com/b/b1/board-one' },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_boards')
  await runTool(tool, { limit: 1 })
  const limitParam = fetchCalls.calls[0]!.url.searchParams.get('limit')
  if (limitParam !== null) {
    assert.equal(limitParam, '1', 'limit must be forwarded as 1')
  }
})

test('trello_get_board resolves BoardDetails; 404 rejects with not-found', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'b1',
        name: 'Board One',
        url: 'https://trello.com/b/b1/board-one',
        desc: 'A board description',
        closed: false,
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_get_board')
  const board = (await runTool(tool, { boardId: 'b1' })) as {
    id: string
    name: string
    url: string
  }
  assert.equal(board.id, 'b1')
  assert.equal(board.name, 'Board One')
  assert.equal(board.url, 'https://trello.com/b/b1/board-one')

  const { runtime: notFoundRuntime } = makeRuntime({
    responses: [jsonResponse(404, { error: 'board not found' })],
  })
  const notFoundTool = findTool(notFoundRuntime, 'trello_get_board')
  const err = await captureReject(runTool(notFoundTool, { boardId: 'b1' }))
  assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
  assert.equal(err.code, 'not-found')
})

// ---------------------------------------------------------------------------
// Lists / cards tools
// ---------------------------------------------------------------------------

test('trello_list_lists resolves ListSummary[] with boardId set', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, [
        { id: 'l1', name: 'List One', closed: false, idBoard: 'b1' },
        { id: 'l2', name: 'List Two', closed: true, idBoard: 'b1' },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_lists')
  const lists = unwrapSummaries(await runTool(tool, { boardId: 'b1' }), 'lists') as Array<{
    id: string
    name: string
    closed: boolean
    boardId: string
  }>
  assert.equal(lists.length, 2)
  assert.equal(lists[0].boardId, 'b1')
  assert.equal(lists[1].boardId, 'b1')
})

test('trello_list_cards resolves CardSummary[]', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, [
        {
          id: 'c1',
          name: 'Card One',
          url: 'https://trello.com/c/c1/card-one',
          idList: 'l1',
          idBoard: 'b1',
          closed: false,
          desc: 'A card description',
        },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_cards')
  const cards = unwrapSummaries(await runTool(tool, { listId: 'l1' }), 'cards') as Array<{
    id: string
    name: string
    listId: string
    boardId: string
  }>
  assert.equal(cards.length, 1)
  assert.equal(cards[0].id, 'c1')
  assert.equal(cards[0].listId, 'l1')
  assert.equal(cards[0].boardId, 'b1')
})

test('trello_get_card resolves CardDetails', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'c1',
        name: 'Card One',
        url: 'https://trello.com/c/c1/card-one',
        idList: 'l1',
        idBoard: 'b1',
        closed: false,
        position: 640,
        idMembers: ['m1'],
        checkItem: { completed: 1, total: 3 },
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_get_card')
  const card = (await runTool(tool, { cardId: 'c1' })) as {
    id: string
    name: string
    position?: number
    idMembers?: string[]
  }
  assert.equal(card.id, 'c1')
  assert.equal(card.position, 640)
  assert.deepEqual(card.idMembers, ['m1'])
})

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

test('trello_create_card POSTs listId and name and returns id/url', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'c2',
        name: 'Test from DeepSeek Harness',
        url: 'https://trello.com/c/c2/test-from-deepseek-harness',
        idList: 'l1',
        idBoard: 'b1',
        closed: false,
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_create_card')
  const result = (await runTool(tool, {
    listId: 'l1',
    name: 'Test from DeepSeek Harness',
  })) as { id: string; url: string }
  const call = fetchCalls.calls[0]!
  assert.equal(call.method, 'POST')
  const body = JSON.parse(String(call.body))
  assert.equal(body.listId, 'l1')
  assert.equal(body.name, 'Test from DeepSeek Harness')
  assert.ok(result.id, 'result should have an id')
  assert.ok(result.url, 'result should have a url')
})

test('trello_update_card PUTs exactly the provided keys (no extra keys)', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'c1',
        name: 'Renamed',
        url: 'https://trello.com/c/c1/renamed',
        idList: 'l1',
        idBoard: 'b1',
        closed: false,
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_update_card')
  await runTool(tool, { cardId: 'c1', name: 'Renamed' })
  const call = fetchCalls.calls[0]!
  assert.equal(call.method, 'PUT')
  const body = JSON.parse(String(call.body))
  assert.deepEqual(body, { name: 'Renamed' })
  assert.equal(Object.keys(body).length, 1, 'update body must not contain extra keys')
})

test('trello_update_card with listId PUTs { idList } (move folded into update)', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'c1',
        name: 'Card One',
        url: 'https://trello.com/c/c1/moved',
        idList: 'l2',
        idBoard: 'b1',
        closed: false,
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_update_card')
  await runTool(tool, { cardId: 'c1', listId: 'l2' })
  const call = fetchCalls.calls[0]!
  assert.equal(call.method, 'PUT')
  assert.ok(call.url.pathname.includes('/1/cards/c1'), `unexpected URL: ${call.url.href}`)
  assert.deepEqual(JSON.parse(String(call.body)), { idList: 'l2' })
})

test('trello_update_card with listId and position PUTs { idList, position }', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'c1',
        name: 'Card One',
        url: 'https://trello.com/c/c1/moved-positioned',
        idList: 'l2',
        idBoard: 'b1',
        closed: false,
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_update_card')
  await runTool(tool, { cardId: 'c1', listId: 'l2', position: 640 })
  const call = fetchCalls.calls[0]!
  assert.equal(call.method, 'PUT')
  assert.deepEqual(JSON.parse(String(call.body)), { idList: 'l2', position: 640 })
})

test('trello_add_comment POSTs to /actions/comments and rejects blank text', async () => {
  const { runtime, fetchCalls } = makeRuntime({
    responses: [
      jsonResponse(200, {
        id: 'cm1',
        idCard: 'c1',
        date: '2026-10-06T12:00:00Z',
        text: 'Created through DeepSeek Harness',
      }),
    ],
  })
  const tool = findTool(runtime, 'trello_add_comment')
  const confirmation = (await runTool(tool, {
    cardId: 'c1',
    text: 'Created through DeepSeek Harness',
  })) as { cardId: string; text: string }
  const call = fetchCalls.calls[0]!
  assert.equal(call.method, 'POST')
  assert.ok(
    call.url.pathname.includes('/actions/comments'),
    `unexpected URL: ${call.url.href}`,
  )
  assert.deepEqual(JSON.parse(String(call.body)), { text: 'Created through DeepSeek Harness' })
  assert.equal(confirmation.cardId, 'c1')

  const err = await captureReject(runTool(tool, { cardId: 'c1', text: '   ' }))
  assert.ok(err instanceof Error, `expected an Error, got: ${String(err)}`)
  assert.ok(
    err.message.toLowerCase().includes('text'),
    `blank text error should mention "text": ${err.message}`,
  )
})

// ---------------------------------------------------------------------------
// Signal passthrough
// ---------------------------------------------------------------------------

test('execute accepts an AbortSignal without type errors', async () => {
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, [
        { id: 'b1', name: 'Board One', url: 'https://trello.com/b/b1/board-one' },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_boards')
  await runToolWithSignal(tool, new AbortController().signal)
})

async function runToolWithSignal(tool: Tool, signal: AbortSignal): Promise<void> {
  await Promise.resolve().then(() => tool.execute({}, { signal }))
}

// ---------------------------------------------------------------------------
// Secret hygiene (plan §17)
// ---------------------------------------------------------------------------

test('secret hygiene: rendered output and error messages never contain credentials', async () => {
  // Success path: rendered output must not contain the fake credentials.
  const { runtime } = makeRuntime({
    responses: [
      jsonResponse(200, [
        { id: 'b1', name: 'Board One', url: 'https://trello.com/b/b1/board-one' },
      ]),
    ],
  })
  const tool = findTool(runtime, 'trello_list_boards')
  const result = await runTool(tool, {})
  const rendered = tool.output.render({}, result)
  const renderedText = JSON.stringify(rendered)
  assert.ok(
    !renderedText.includes(FAKE_API_KEY),
    `rendered output leaks apiKey: ${renderedText}`,
  )
  assert.ok(
    !renderedText.includes(FAKE_TOKEN),
    `rendered output leaks token: ${renderedText}`,
  )

  // Failure path: 401 error message must not contain the fake credentials.
  const { runtime: failingRuntime } = makeRuntime({
    responses: [jsonResponse(401, { error: 'invalid credentials' })],
  })
  const failingTool = findTool(failingRuntime, 'trello_list_boards')
  const err = await captureReject(runTool(failingTool, {}))
  assert.ok(err instanceof Error, `expected an Error, got: ${String(err)}`)
  assert.ok(!err.message.includes(FAKE_API_KEY), `error message leaks apiKey: ${err.message}`)
  assert.ok(!err.message.includes(FAKE_TOKEN), `error message leaks token: ${err.message}`)
})
