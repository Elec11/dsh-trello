// Quick check: does the Config schema accept the shipped cordis.patch.yml shape?
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? `${here}/../dist/src/index.js`
const mod = await import(pathToFileURL(target).href)
const cases = {
  'empty {}': {},
  'shipped (empty strings)': { apiKey: '', token: '' },
  'with values': { apiKey: 'k', token: 't' },
  'with optional': { apiKey: 'k', token: 't', baseUrl: 'https://api.trello.com', timeoutMs: 30000 },
}
for (const [label, cfg] of Object.entries(cases)) {
  try {
    const r = mod.Config(cfg)
    console.log(`OK   ${label} -> ${r ? 'parsed' : 'falsy'}`)
  } catch (e) {
    console.log(`ERR  ${label} -> ${e.message}`)
  }
}
