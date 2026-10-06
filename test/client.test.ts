import test from 'node:test'
import assert from 'node:assert/strict'

import { TrelloClient } from '../src/trello/client.js'
import { TrelloConfigError, TrelloError } from '../src/trello/errors.js'
import type { TrelloClientConfig } from '../src/trello/types.js'

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

function makeClient(options: FakeFetchOptions = {}, clientOptions: Partial<TrelloClientConfig> = {}) {
  const fetchCalls = new FakeFetch(options)
  const client = new TrelloClient({
    apiKey: FAKE_API_KEY,
    token: FAKE_TOKEN,
    fetchImpl: fetchCalls.fetch,
    ...clientOptions,
  })
  return { client, fetchCalls }
}

// @types/node's assert.throws/assert.rejects return void, so capture the error manually.
function captureThrow(block: () => unknown): unknown {
  try {
    block()
  } catch (err) {
    return err
  }
  throw new Error('expected function to throw')
}

async function captureReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected promise to reject')
}

function assertNoSecrets(message: string, label: string): void {
  assert.ok(!message.includes(FAKE_API_KEY), `${label}: apiKey leaked in: ${message}`)
  assert.ok(!message.includes(FAKE_TOKEN), `${label}: token leaked in: ${message}`)
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('authentication', async (t) => {
  await t.test('missing apiKey throws TrelloConfigError', () => {
    const err = captureThrow(() => new TrelloClient({ token: FAKE_TOKEN } as TrelloClientConfig))
    assert.ok(err instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(err)}`)
    assert.ok(err instanceof TrelloError, 'expected TrelloError subclass')
    assert.ok(
      err.message.includes('Trello plugin is not configured'),
      `unexpected message: ${err.message}`,
    )
  })

  await t.test('missing token throws TrelloConfigError', () => {
    const err = captureThrow(() => new TrelloClient({ apiKey: FAKE_API_KEY } as TrelloClientConfig))
    assert.ok(err instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(err)}`)
    assert.ok(
      err.message.includes('Trello plugin is not configured'),
      `unexpected message: ${err.message}`,
    )
  })

  await t.test('empty apiKey or token throws TrelloConfigError', () => {
    const errKey = captureThrow(() => new TrelloClient({ apiKey: '', token: FAKE_TOKEN } as TrelloClientConfig))
    assert.ok(errKey instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(errKey)}`)
    const errToken = captureThrow(() => new TrelloClient({ apiKey: FAKE_API_KEY, token: '' } as TrelloClientConfig))
    assert.ok(errToken instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(errToken)}`)
  })

  await t.test('verifyCredentials succeeds and sends key/token as query params', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [jsonResponse(200, { id: 'member1' })],
    })
    await client.verifyCredentials()
    assert.equal(fetchCalls.calls.length, 1, 'expected exactly one request')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(
      call.url.href.includes(`key=${FAKE_API_KEY}`),
      `URL missing key param: ${call.url.href}`,
    )
    assert.ok(
      call.url.href.includes(`token=${FAKE_TOKEN}`),
      `URL missing token param: ${call.url.href}`,
    )
  })

  await t.test('401 rejects verifyCredentials with authentication error', async () => {
    const { client } = makeClient({
      responses: [jsonResponse(401, { error: 'invalid credentials' })],
    })
    const err = await captureReject(client.verifyCredentials())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'authentication')
    assert.ok(
      err.message.startsWith('Trello authentication failed'),
      `unexpected message: ${err.message}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

test('boards', async (t) => {
  await t.test('getBoards maps the raw API array to BoardSummary[]', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, [
          { id: 'b1', name: 'Board One', url: 'https://trello.com/b/b1/board-one' },
          { id: 'b2', name: 'Board Two', url: 'https://trello.com/b/b2/board-two' },
        ]),
      ],
    })
    const boards = await client.getBoards()
    assert.equal(boards.length, 2)
    assert.equal(boards[0]!.id, 'b1')
    assert.equal(boards[0]!.name, 'Board One')
    assert.equal(boards[0]!.url, 'https://trello.com/b/b1/board-one')
    assert.equal(boards[1]!.name, 'Board Two')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(
      call.url.pathname.includes('/1/members/you/boards'),
      `unexpected URL: ${call.url.href}`,
    )
  })

  await t.test('getBoard maps BoardDetails (id/name/url plus desc/closed/labelName pass-through)', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'b1',
          name: 'Board One',
          url: 'https://trello.com/b/b1/board-one',
          desc: 'A board description',
          closed: false,
          labelName: 'Green',
        }),
      ],
    })
    const board = await client.getBoard('b1')
    assert.equal(board.id, 'b1')
    assert.equal(board.name, 'Board One')
    assert.equal(board.url, 'https://trello.com/b/b1/board-one')
    assert.equal(board.desc, 'A board description')
    assert.equal(board.closed, false)
    assert.equal(board.labelName, 'Green')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(call.url.pathname.includes('/1/boards/b1'), `unexpected URL: ${call.url.href}`)
  })

  await t.test('404 board rejects with not-found and a named message', async () => {
    const { client } = makeClient({
      responses: [jsonResponse(404, { error: 'board not found' })],
    })
    const err = await captureReject(client.getBoard('b1'))
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'not-found')
    assert.equal(err.message, 'Trello board not found: b1')
  })
})

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('lists', async (t) => {
  await t.test('getLists maps ListSummary[] with boardId from idBoard', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, [
          { id: 'l1', name: 'List One', closed: false, idBoard: 'b1' },
          { id: 'l2', name: 'List Two', closed: true, idBoard: 'b1' },
        ]),
      ],
    })
    const lists = await client.getLists('b1')
    assert.equal(lists.length, 2)
    assert.equal(lists[0]!.id, 'l1')
    assert.equal(lists[0]!.name, 'List One')
    assert.equal(lists[0]!.closed, false)
    assert.equal(lists[0]!.boardId, 'b1')
    assert.equal(lists[1]!.boardId, 'b1')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(
      call.url.pathname.includes('/1/boards/b1/lists'),
      `unexpected URL: ${call.url.href}`,
    )
  })

  await t.test('404 board for lists rejects with not-found', async () => {
    const { client } = makeClient({
      responses: [jsonResponse(404, { error: 'board not found' })],
    })
    const err = await captureReject(client.getLists('b1'))
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'not-found')
  })
})

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

test('cards', async (t) => {
  await t.test('getCards maps CardSummary[] (listId/boardId/description/due/labelNames)', async () => {
    const { client, fetchCalls } = makeClient({
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
            due: '2026-10-06T12:00:00Z',
            labelNames: ['Green', 'Red'],
          },
        ]),
      ],
    })
    const cards = await client.getCards('l1')
    assert.equal(cards.length, 1)
    const card = cards[0]!
    assert.equal(card.id, 'c1')
    assert.equal(card.name, 'Card One')
    assert.equal(card.url, 'https://trello.com/c/c1/card-one')
    assert.equal(card.listId, 'l1')
    assert.equal(card.boardId, 'b1')
    assert.equal(card.closed, false)
    assert.equal(card.description, 'A card description')
    assert.equal(card.due, '2026-10-06T12:00:00Z')
    assert.deepEqual(card.labelNames, ['Green', 'Red'])
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(
      call.url.pathname.includes('/1/lists/l1/cards'),
      `unexpected URL: ${call.url.href}`,
    )
  })

  await t.test('getCard returns CardDetails with position/idMembers/checkItem', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'c1',
          name: 'Card One',
          url: 'https://trello.com/c/c1/card-one',
          idList: 'l1',
          idBoard: 'b1',
          closed: false,
          position: 640,
          idMembers: ['m1', 'm2'],
          checkItem: { completed: 1, total: 3 },
        }),
      ],
    })
    const card = await client.getCard('c1')
    assert.equal(card.id, 'c1')
    assert.equal(card.position, 640)
    assert.deepEqual(card.idMembers, ['m1', 'm2'])
    assert.deepEqual(card.checkItem, { completed: 1, total: 3 })
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'GET')
    assert.ok(call.url.pathname.includes('/1/cards/c1'), `unexpected URL: ${call.url.href}`)
  })

  await t.test('createCard POSTs to /1/cards with exactly listId and name', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'c2',
          name: 'New card',
          url: 'https://trello.com/c/c2/new-card',
          idList: 'l1',
          idBoard: 'b1',
          closed: false,
        }),
      ],
    })
    const card = await client.createCard({ listId: 'l1', name: 'New card' })
    assert.equal(card.id, 'c2')
    assert.equal(card.name, 'New card')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'POST')
    assert.ok(call.url.pathname.includes('/1/cards'), `unexpected URL: ${call.url.href}`)
    assert.deepEqual(JSON.parse(String(call.body)), { listId: 'l1', name: 'New card' })
  })

  await t.test('createCard with due/position/labelIds sends exactly those keys', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'c3',
          name: 'Loaded card',
          url: 'https://trello.com/c/c3/loaded-card',
          idList: 'l1',
          idBoard: 'b1',
          closed: false,
        }),
      ],
    })
    await client.createCard({
      listId: 'l1',
      name: 'Loaded card',
      due: '2026-11-01T09:00:00Z',
      position: 640,
      labelIds: ['lab1', 'lab2'],
    })
    const body = JSON.parse(String(fetchCalls.calls[0]!.body))
    assert.deepEqual(body, {
      listId: 'l1',
      name: 'Loaded card',
      due: '2026-11-01T09:00:00Z',
      position: 640,
      labelIds: ['lab1', 'lab2'],
    })
  })

  await t.test('updateCard sends only the provided keys (no silent overwrites)', async () => {
    const { client, fetchCalls } = makeClient({
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
    await client.updateCard('c1', { name: 'Renamed' })
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'PUT')
    assert.ok(call.url.pathname.includes('/1/cards/c1'), `unexpected URL: ${call.url.href}`)
    const body = JSON.parse(String(call.body))
    assert.deepEqual(body, { name: 'Renamed' })
    assert.equal(Object.keys(body).length, 1, 'update body must contain exactly one key')
  })

  await t.test('updateCard with due null sends { due: null }', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'c1',
          name: 'Card One',
          url: 'https://trello.com/c/c1/clear-due',
          idList: 'l1',
          idBoard: 'b1',
          closed: false,
        }),
      ],
    })
    await client.updateCard('c1', { due: null })
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'PUT')
    const body = JSON.parse(String(call.body))
    assert.deepEqual(body, { due: null })
  })

  await t.test('updateCard with listId PUTs { idList } to /1/cards/:id', async () => {
    const { client, fetchCalls } = makeClient({
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
    await client.updateCard('c1', { listId: 'l2' })
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'PUT')
    assert.ok(call.url.pathname.includes('/1/cards/c1'), `unexpected URL: ${call.url.href}`)
    assert.deepEqual(JSON.parse(String(call.body)), { idList: 'l2' })
  })

  await t.test('updateCard with listId and position sends { idList, position }', async () => {
    const { client, fetchCalls } = makeClient({
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
    await client.updateCard('c1', { listId: 'l2', position: 640 })
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'PUT')
    assert.deepEqual(JSON.parse(String(call.body)), { idList: 'l2', position: 640 })
  })
})

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

test('comments', async (t) => {
  await t.test('addComment POSTs to /1/cards/:id/actions/comments and returns the confirmation', async () => {
    const { client, fetchCalls } = makeClient({
      responses: [
        jsonResponse(200, {
          id: 'cm1',
          idCard: 'c1',
          date: '2026-10-06T12:00:00Z',
          text: 'hello',
        }),
      ],
    })
    const confirmation = await client.addComment('c1', 'hello')
    assert.equal(confirmation.id, 'cm1')
    assert.equal(confirmation.cardId, 'c1')
    assert.equal(confirmation.date, '2026-10-06T12:00:00Z')
    assert.equal(confirmation.text, 'hello')
    const call = fetchCalls.calls[0]!
    assert.equal(call.method, 'POST')
    assert.ok(
      call.url.pathname.includes('/1/cards/c1/actions/comments'),
      `unexpected URL: ${call.url.href}`,
    )
    assert.deepEqual(JSON.parse(String(call.body)), { text: 'hello' })
  })
})

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

test('reliability', async (t) => {
  await t.test('429 with Retry-After maps to rate-limited with retryAfterSeconds', async () => {
    const { client } = makeClient({
      responses: [jsonResponse(429, { error: 'too many requests' }, { 'retry-after': '30' })],
    })
    const err = await captureReject(client.getBoards())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'rate-limited')
    assert.equal(err.retryAfterSeconds, 30)
    assert.ok(err.message.includes('rate limit exceeded'), `unexpected message: ${err.message}`)
  })

  await t.test('500 maps to service-failure', async () => {
    const { client } = makeClient({
      responses: [jsonResponse(500, { error: 'boom' })],
    })
    const err = await captureReject(client.getBoards())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'service-failure')
    assert.ok(err.message.includes('Trello service failure'), `unexpected message: ${err.message}`)
  })

  await t.test('malformed JSON body maps to malformed-response', async () => {
    const { client } = makeClient({
      responses: [
        new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
      ],
    })
    const err = await captureReject(client.getBoards())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'malformed-response')
  })

  await t.test('network failure maps to network and never includes the URL', async () => {
    const { client, fetchCalls } = makeClient({ rejectWith: new TypeError('fetch failed') })
    const err = await captureReject(client.getBoards())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'network')
    const url = fetchCalls.calls[0]!.url.href
    assert.ok(!err.message.includes(url), `error message contains the URL: ${err.message}`)
  })

  await t.test('timeout: never-resolving fetch with timeoutMs rejects with timeout', async () => {
    // The fake honors the signal: when the client's AbortSignal.timeout fires,
    // the pending fetch rejects with an AbortError, which the client must map
    // to code 'timeout'.
    const { client } = makeClient({}, { timeoutMs: 50 })
    const err = await captureReject(client.getBoards())
    assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
    assert.equal(err.code, 'timeout')
  })
})

// ---------------------------------------------------------------------------
// Security: credentials must never leak into error messages (plan §17)
// ---------------------------------------------------------------------------

test('security: credentials never leak into error messages', async (t) => {
  const scenarios: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: '401 authentication failure',
      run: async () => {
        const { client } = makeClient({
          responses: [jsonResponse(401, { error: 'invalid credentials' })],
        })
        return client.verifyCredentials()
      },
    },
    {
      name: '404 not found',
      run: async () => {
        const { client } = makeClient({
          responses: [jsonResponse(404, { error: 'board not found' })],
        })
        return client.getBoard('b1')
      },
    },
    {
      name: '429 rate limited',
      run: async () => {
        const { client } = makeClient({
          responses: [jsonResponse(429, { error: 'slow down' }, { 'retry-after': '30' })],
        })
        return client.getBoards()
      },
    },
    {
      name: '500 service failure',
      run: async () => {
        const { client } = makeClient({
          responses: [jsonResponse(500, { error: 'boom' })],
        })
        return client.getBoards()
      },
    },
    {
      name: 'network failure',
      run: async () => {
        const { client } = makeClient({ rejectWith: new TypeError('fetch failed') })
        return client.getBoards()
      },
    },
    {
      name: 'malformed response',
      run: async () => {
        const { client } = makeClient({
          responses: [
            new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
          ],
        })
        return client.getBoards()
      },
    },
  ]

  for (const scenario of scenarios) {
    await t.test(`${scenario.name} does not leak credentials`, async () => {
      const err = await captureReject(scenario.run())
      assert.ok(err instanceof TrelloError, `expected TrelloError, got: ${String(err)}`)
      assertNoSecrets(err.message, scenario.name)
    })
  }

  await t.test('TrelloConfigError message contains no credential values', () => {
    const err = captureThrow(() => new TrelloClient({ token: FAKE_TOKEN } as TrelloClientConfig))
    assert.ok(err instanceof TrelloConfigError, `expected TrelloConfigError, got: ${String(err)}`)
    assertNoSecrets(err.message, 'config error')
  })
})
