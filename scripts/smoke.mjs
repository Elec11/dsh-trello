// Standalone smoke test: loads the built plugin module with a mock Harness
// context and verifies the plugin contract (exports, registration, error path).
// Usage: node scripts/smoke.mjs   (run after `npm run build`)
import assert from 'node:assert/strict'

const mod = await import('../dist/src/index.js')

// 1. Plugin module exports
assert.equal(typeof mod.Config, 'function', 'Config must be a schema (callable)')
assert.equal(mod.name, 'tool-trello', 'name must be tool-trello')
assert.deepEqual(mod.inject, ['tools'], 'inject must be [tools]')
assert.equal(typeof mod.apply, 'function', 'apply must be a function')

// 2. Config schema accepts an empty config (the row ships with config: {})
const parsed = mod.Config({})
assert.ok(parsed, 'Config({}) must parse')

// 3. Registration with a mock context
const registered = []
const ctx = {
  tools: { register: (def) => registered.push(def) },
  logger: { warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { entry: { options: { id: 'tool-trello' } } },
}
mod.apply(ctx, {})
const names = registered.map((t) => t.name).sort()
assert.deepEqual(names, [
  'trello_add_comment',
  'trello_create_card',
  'trello_get_board',
  'trello_get_card',
  'trello_list_boards',
  'trello_list_cards',
  'trello_list_lists',
  'trello_update_card',
], 'all eight tools must be registered, got: ' + names.join(', '))

// 4. Every definition has the required shape
for (const def of registered) {
  assert.equal(typeof def.name, 'string')
  assert.equal(typeof def.description, 'string')
  assert.equal(def.parameters.type, 'object')
  assert.equal(def.parameters.additionalProperties, false)
  assert.equal(typeof def.output.schema, 'object')
  assert.equal(typeof def.output.render, 'function')
  assert.equal(typeof def.execute, 'function')
  assert.equal(typeof def.timeoutMs, 'number')
}

// 5. Missing credentials → clear configuration error (no crash at registration)
delete process.env.TRELLO_API_KEY
delete process.env.TRELLO_TOKEN
const listBoards = registered.find((t) => t.name === 'trello_list_boards')
let threw = null
try {
  await listBoards.execute({}, {})
} catch (error) {
  threw = error
}
assert.ok(threw, 'trello_list_boards must throw when unconfigured')
assert.match(threw.message, /Trello plugin is not configured\. Set TRELLO_API_KEY and TRELLO_TOKEN\./,
  'unconfigured error message must be exact, got: ' + threw.message)
assert.ok(!threw.message.includes('FAKE'), 'error must not leak credentials')

// 6. With env credentials, a call reaches the (fake) fetch
process.env.TRELLO_API_KEY = 'FAKE_API_KEY_123'
process.env.TRELLO_TOKEN = 'FAKE_TOKEN_456'
const fetchCalls = []
const fakeFetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init.method })
  return new Response(JSON.stringify([
    { id: 'b1', name: 'Test Board', url: 'https://trello.com/b/b1' },
  ]), { status: 200, headers: { 'content-type': 'application/json' } })
}
// Rebuild the runtime with the fake fetch by re-applying with a fresh ctx
const registered2 = []
const ctx2 = {
  tools: { register: (def) => registered2.push(def) },
  logger: { warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { entry: { options: { id: 'tool-trello' } } },
}
// Patch global fetch for this process
const realFetch = globalThis.fetch
globalThis.fetch = fakeFetch
try {
  mod.apply(ctx2, {})
  const boardsTool = registered2.find((t) => t.name === 'trello_list_boards')
  const result = await boardsTool.execute({}, {})
  assert.ok(result && Array.isArray(result.boards), 'boards result must be { boards: [...] }')
  assert.equal(result.boards.length, 1)
  assert.equal(result.boards[0].name, 'Test Board')
  assert.ok(fetchCalls.length >= 1, 'fake fetch must have been called')
  const url = fetchCalls[0].url
  assert.ok(url.includes('key=FAKE_API_KEY_123'), 'auth key must be in the query string')
  assert.ok(url.includes('token=FAKE_TOKEN_456'), 'auth token must be in the query string')
  assert.ok(!url.includes('Authorization'), 'no Authorization header mechanism')
  const rendered = boardsTool.output.render({}, result)
  const text = rendered.map((p) => p.text).join('\n')
  assert.ok(text.includes('Test Board'), 'render must include the board name')
  assert.ok(!text.includes('FAKE_API_KEY_123') && !text.includes('FAKE_TOKEN_456'),
    'rendered output must not leak credentials')
} finally {
  globalThis.fetch = realFetch
  delete process.env.TRELLO_API_KEY
  delete process.env.TRELLO_TOKEN
}

console.log('SMOKE OK — plugin contract verified: 8 tools registered, config error path exact, auth via query params, no credential leaks.')
