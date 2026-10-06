// Faithful DSH-contract verification: uses the REAL dsh-tools schema gate
// (assertSupportedJsonSchema — the exact check register() runs) on every output
// schema, and the real result validator (validateJsonSchemaValue) on executed
// results. Run after `npm run build`:  node scripts/verify-dsh.mjs
import assert from 'node:assert/strict'

// Import the intact json-schema module directly (lib/index.js is head-truncated
// in the asar extraction). Its bare imports (dsh-llm, dsh-util-values) resolve
// through the dsh-tools package scope.
const DSH_SCHEMA = new URL(
  '../.work/dsh/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js',
  import.meta.url,
)
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(DSH_SCHEMA)

const mod = await import('../dist/src/index.js')

// 1. Register with a mock context.
const registered = []
mod.apply(
  { tools: { register: (def) => registered.push(def) }, logger: { warn: () => {}, error: () => {}, debug: () => {} } },
  {},
)
assert.equal(registered.length, 8, 'eight tools registered')

// 2. The exact registration gate: every output schema must be a supported schema.
for (const def of registered) {
  assertSupportedJsonSchema(def.output.schema) // throws JsonSchemaError on violation
  console.log(`  ok  output schema valid: ${def.name}`)
}

// 3. Parameter schemas: confirm they use no type-arrays (DSH's enforced subset
//    rejects them); parameters are not asserted at register() but must not
//    contain the unsupported keyword form.
function assertNoTypeArray(node, path) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) assertNoTypeArray(node[i], `${path}[${i}]`)
    return
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.type)) throw new Error(`type-array at ${path}`)
    for (const [k, v] of Object.entries(node)) assertNoTypeArray(v, `${path}.${k}`)
  }
}
for (const def of registered) assertNoTypeArray(def.parameters, def.name)
console.log('  ok  no type-arrays in any parameter schema')

// 4. Execute each tool against a fake fetch and validate the real result
//    against the real output schema (mirrors createSuccessResult).
const fakeBoards = [{ id: 'b1', name: 'Test Board', url: 'https://trello.com/b/b1' }]
const fakeLists = [{ id: 'l1', name: 'To Do', closed: false, pos: 1, idBoard: 'b1' }]
const fakeCard = {
  id: 'c1', name: 'Card', idList: 'l1', idBoard: 'b1', closed: false,
  desc: null, due: null, url: 'https://trello.com/c/c1',
  position: 64, idMembers: [], checkItem: { complete: 0, total: 0 },
}
const fakeComment = { id: 'cm1', text: 'hi', date: '2026-01-01T00:00:00Z', idCard: 'c1' }

const calls = []
const fakeFetch = async (url, init) => {
  calls.push({ url: String(url), method: init.method, body: init.body })
  const u = new URL(url)
  let payload
  if (u.pathname.endsWith('/members/you/boards')) payload = fakeBoards
  else if (u.pathname.endsWith('/boards/b1')) payload = fakeBoards[0]
  else if (u.pathname.endsWith('/boards/b1/lists')) payload = fakeLists
  else if (u.pathname.endsWith('/lists/l1/cards')) payload = [fakeCard]
  else if (u.pathname.endsWith('/cards/c1')) payload = init.method === 'POST' ? { ...fakeCard, idList: 'l2' } : fakeCard
  else if (u.pathname.endsWith('/cards/c1/actions/comments')) payload = fakeComment
  else if (u.pathname === '/1/cards') payload = fakeCard
  else throw new Error('unexpected path ' + u.pathname)
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}
process.env.TRELLO_API_KEY = 'FAKE_API_KEY_123'
process.env.TRELLO_TOKEN = 'FAKE_TOKEN_456'
const realFetch = globalThis.fetch
globalThis.fetch = fakeFetch

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const scenarios = [
  ['trello_list_boards', {}],
  ['trello_get_board', { boardId: 'b1' }],
  ['trello_list_lists', { boardId: 'b1' }],
  ['trello_list_cards', { listId: 'l1' }],
  ['trello_get_card', { cardId: 'c1' }],
  ['trello_create_card', { listId: 'l1', name: 'New' }],
  ['trello_update_card', { cardId: 'c1', name: 'Renamed' }],
  ['trello_update_card', { cardId: 'c1', listId: 'l2', position: 64 }],
  ['trello_add_comment', { cardId: 'c1', text: 'hello' }],
]
try {
  for (const [name, args] of scenarios) {
    const def = byName[name]
    const result = await def.execute(args, {})
    // Real lossless-JSON snapshot check (mirrors snapshotToolValue).
    const { snapshotJsonValue } = await import(
      new URL('../.work/dsh/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js', import.meta.url)
    )
    const detached = snapshotJsonValue(result)
    assert.ok(detached !== undefined, `${name}: result must be lossless JSON (no undefined values)`)
    // Real schema validation.
    const violations = validateJsonSchemaValue(def.output.schema, detached, 'value')
    assert.deepEqual(violations, [], `${name}: schema violations: ${violations.join('; ')}`)
    // Render must not throw and must not leak credentials.
    const rendered = def.output.render(args, detached)
    const text = rendered.map((p) => p.text).join('\n')
    assert.ok(!text.includes('FAKE_API_KEY_123') && !text.includes('FAKE_TOKEN_456'), `${name}: render leaks credentials`)
    console.log(`  ok  ${name}: lossless JSON + schema-valid + render clean`)
  }
} finally {
  globalThis.fetch = realFetch
  delete process.env.TRELLO_API_KEY
  delete process.env.TRELLO_TOKEN
}

console.log('\nVERIFY OK — all 8 output schemas pass the real DSH register() gate; every executed result is lossless JSON, schema-valid, and renders without credential leaks.')
