// Live dry-run against production: every one of the 100 tools must return valid, in-policy 402 terms.
// Spends nothing and needs no key.   LIVE=1 node --test test/live.test.mjs   (npm run test:live)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, createCaelaraClient } from '../dist/index.js'

const live = process.env.LIVE === '1'
const sample = (p) => (p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : p.type === 'object' ? {} : p.name === 'url' ? 'https://example.com' : p.name === 'domain' ? 'example.com' : p.name === 'email' ? 'user@example.com' : p.name === 'address' || p.name === 'token' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : 'example')

test('all 100 tools return valid in-policy 402 terms on production', { skip: !live }, async () => {
  const client = createCaelaraClient({})
  const failures = []
  for (const t of TOOLS) {
    try {
      const args = Object.fromEntries(t.params.filter((p) => p.required).map((p) => [p.name, sample(p)]))
      const r = await client.dryRun(t.name, args)
      assert.equal(r.httpStatus, 402)
      assert.equal(r.terms.priceUsdc, Number(t.priceUsdc))
      assert.ok(r.terms.resource.startsWith(`https://${t.host}/`))
    } catch (e) { failures.push(`${t.name}: ${e.message}`) }
  }
  assert.deepEqual(failures, [])
})
