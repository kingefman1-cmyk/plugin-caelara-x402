// Offline tests (mocked fetch, no network, no keys). Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin, { TOOLS, PAY_TO, USDC_BASE, CATALOG_COUNTS, createCaelaraClient, buildRequest, getTool, toolSchemas, toOpenAITools, createElizaPlugin, agentKitActions, gameFunctions, selectTools } from '../dist/index.js'

const terms = (over = {}) => ({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '5000', resource: 'https://crypto.caelaralabs.com/v1/token-price-aggregator', payTo: PAY_TO, asset: USDC_BASE, ...over }] })
const mockFetch = (status, body, headers = { 'x-payment-required': 'x402' }) => async () => new Response(JSON.stringify(body), { status, headers })

test('catalog: 100 tools in 10 suites, unique names, tier counts and prices match', () => {
  assert.equal(TOOLS.length, 100)
  assert.deepEqual(CATALOG_COUNTS, { suites: 10, endpoints: 100, composites: 20, atomics: 80 })
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 100)
  assert.equal(new Set(TOOLS.map((t) => t.suite)).size, 10)
  for (const t of TOOLS) {
    assert.ok(['0.005', '0.025'].includes(t.priceUsdc))
    assert.equal(t.priceUsdc, t.tier === 'composite' ? '0.025' : '0.005')
    assert.equal(t.host, `${t.suite}.caelaralabs.com`)
    assert.ok(t.path.startsWith('/v1/'))
  }
  assert.match(PAY_TO, /^0x[0-9a-fA-F]{40}$/)
})

test('buildRequest validates arguments and builds GET query / POST body', () => {
  const price = getTool('crypto_token_price_aggregator')
  assert.equal(buildRequest(price, { symbol: 'ETH' }).url, 'https://crypto.caelaralabs.com/v1/token-price-aggregator?symbol=ETH')
  assert.throws(() => buildRequest(price, {}), /missing required argument "symbol"/)
  assert.throws(() => buildRequest(price, { symbol: 'ETH', nope: 1 }), /unknown argument "nope"/)
  const post = TOOLS.find((t) => t.method === 'POST')
  const args = Object.fromEntries(post.params.filter((p) => p.required).map((p) => [p.name, p.type === 'boolean' ? true : p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'array' ? [] : p.type === 'object' ? {} : 'x']))
  const r = buildRequest(post, args)
  assert.equal(r.method, 'POST')
  assert.equal(typeof JSON.parse(r.body), 'object')
  assert.throws(() => buildRequest(getTool('api_sitemap_crawler'), { url: 'https://x.org', limit: 'ten' }), /must be of type integer/)
})

test('dryRun parses a 402 and enforces network, asset, payTo and the MAX_USDC cap', async () => {
  const ok = await createCaelaraClient({ fetch: mockFetch(402, terms()) }).dryRun('crypto_token_price_aggregator', { symbol: 'ETH' })
  assert.equal(ok.httpStatus, 402)
  assert.equal(ok.terms.priceUsdc, 0.005)
  assert.equal(ok.terms.payTo, PAY_TO)
  const bad = async (over, re, opts = {}) => assert.rejects(createCaelaraClient({ fetch: mockFetch(402, terms(over)), ...opts }).dryRun('crypto_token_price_aggregator', { symbol: 'ETH' }), re)
  await bad({ network: 'ethereum' }, /network ethereum/)
  await bad({ asset: '0x0000000000000000000000000000000000000001' }, /not native USDC/)
  await bad({ payTo: '0x0000000000000000000000000000000000000002' }, /pinned address/)
  await bad({ maxAmountRequired: '25000' }, /exceeds the maxUsdc cap of 0.005/, { maxUsdc: 0.005 })
  await assert.rejects(createCaelaraClient({ fetch: mockFetch(402, terms(), {}) }).dryRun('crypto_token_price_aggregator', { symbol: 'ETH' }), /X-Payment-Required/)
  // payTo check can be disabled explicitly
  const free = await createCaelaraClient({ payTo: null, fetch: mockFetch(402, terms({ payTo: '0x0000000000000000000000000000000000000002' })) }).dryRun('crypto_token_price_aggregator', { symbol: 'ETH' })
  assert.equal(free.terms.payTo, '0x0000000000000000000000000000000000000002')
})

test('call: no key and out-of-policy terms fail BEFORE anything is signed', async () => {
  let signed = 0
  const paidFetchFactory = async () => { signed++; return { fetch: async () => new Response('{}', { status: 200 }), decode: () => ({}) } }
  await assert.rejects(createCaelaraClient({ fetch: mockFetch(402, terms()), paidFetchFactory }).call('crypto_token_price_aggregator', { symbol: 'ETH' }), /privateKey is required/)
  await assert.rejects(createCaelaraClient({ privateKey: '0xabc', maxUsdc: 0.005, fetch: mockFetch(402, terms({ maxAmountRequired: '25000' })), paidFetchFactory }).call('crypto_token_price_aggregator', { symbol: 'ETH' }), /exceeds/)
  assert.equal(signed, 0, 'the paying fetch must never be created when the terms are refused')
})

test('call: pays within policy and returns data plus the decoded receipt', async () => {
  let cap = null
  const calls = []
  const doFetch = async (url) => (calls.push(url), new Response(JSON.stringify(terms()), { status: 402, headers: { 'x-payment-required': 'x402' } }))
  const paidFetchFactory = async (maxAtomic) => {
    cap = maxAtomic
    return { fetch: async () => new Response(JSON.stringify({ symbol: 'ETH', price: 1 }), { status: 200, headers: { 'x-payment-response': 'x' } }), decode: () => ({ success: true, network: 'base', payer: '0xabc', transaction: '0x' + '1'.repeat(64) }) }
  }
  const r = await createCaelaraClient({ privateKey: '0xabc', fetch: doFetch, paidFetchFactory }).call('crypto_token_price_aggregator', { symbol: 'ETH' })
  assert.equal(cap, 25000n, 'default cap is $0.025 in atomic units')
  assert.equal(r.status, 200)
  assert.equal(r.paid, true)
  assert.equal(r.receipt.basescan, `https://basescan.org/tx/0x${'1'.repeat(64)}`)
  assert.deepEqual(r.data, { symbol: 'ETH', price: 1 })
})

test('tool schemas: 100 JSON-Schema definitions and the OpenAI wrapper', () => {
  const s = toolSchemas()
  assert.equal(s.length, 100)
  for (const x of s) { assert.equal(x.parameters.type, 'object'); assert.equal(x.parameters.additionalProperties, false); assert.match(x.description, /USDC per call on Base/) }
  assert.equal(toOpenAITools()[0].type, 'function')
  assert.equal(selectTools({ suites: ['crypto'] }).length, 10)
  assert.equal(selectTools({ tools: ['api_seo_xray'] }).length, 1)
})

test('ElizaOS plugin: 100 actions, validate gates on a key, handler uses options.parameters and returns an ActionResult', async () => {
  assert.equal(plugin.actions.length, 100)
  const client = { tools: TOOLS, maxUsdc: 0.025, dryRun: async () => ({ tool: 'x', url: 'u', httpStatus: 402, terms: { priceUsdc: 0.005, network: 'base', payTo: PAY_TO } }), call: async (name, args) => ({ tool: name, status: 200, paid: true, priceUsdc: 0.005, data: { echoed: args }, receipt: { basescan: 'https://basescan.org/tx/0xabc' } }) }
  const p = createElizaPlugin({ client })
  assert.equal(p.name, 'caelara-x402')
  const action = p.actions.find((a) => a.name === 'CAELARA_CRYPTO_TOKEN_PRICE_AGGREGATOR')
  assert.ok(action)
  assert.deepEqual(action.parameters.map((x) => [x.name, x.required]), [['symbol', true], ['address', false]])
  assert.equal(await action.validate({}), true)
  const sent = []
  const res = await action.handler({}, { content: { text: 'price of eth' } }, undefined, { parameters: { symbol: 'ETH', ignored: 1 } }, async (c) => sent.push(c))
  assert.equal(res.success, true)
  assert.deepEqual(res.data.data, { echoed: { symbol: 'ETH' } })
  assert.match(sent[0].text, /receipt https:\/\/basescan.org\/tx\/0xabc/)
  // text fallback
  const viaText = await action.handler({}, { content: { text: '{"symbol":"BTC"}' } }, undefined, {}, undefined)
  assert.deepEqual(viaText.data.data, { echoed: { symbol: 'BTC' } })
  // errors become { success:false } instead of throwing
  const failing = createElizaPlugin({ client: { ...client, call: async () => { throw new Error('refusing: too expensive') } } }).actions[0]
  const fail = await failing.handler({}, { content: {} }, undefined, { parameters: {} }, undefined)
  assert.equal(fail.success, false)
  assert.match(fail.error, /too expensive/)
  // dryRun mode reports terms and never calls
  const dry = createElizaPlugin({ client, dryRun: true }).actions[0]
  const d = await dry.handler({}, {}, undefined, { parameters: {} }, undefined)
  assert.match(d.text, /Nothing was paid/)
  // without a key or dry-run the actions are not offered
  assert.equal(await createElizaPlugin().actions[0].validate({ getSetting: () => undefined }), false)
})

test('AgentKit adapter builds zod-style schemas per parameter type', async () => {
  const log = []
  const chain = (kind) => ({ kind, describe(d) { return { ...this, d } }, optional() { return { ...this, optional: true } }, int() { return { ...this, kind: 'int' } } })
  const z = { string: () => chain('string'), number: () => chain('number'), boolean: () => chain('boolean'), array: () => chain('array'), any: () => chain('any'), record: () => chain('record'), object: (shape) => (log.push(shape), { shape }) }
  const client = { call: async (n, a) => ({ n, a }) }
  const acts = agentKitActions({ z, client, suites: ['api'] })
  assert.equal(acts.length, 10)
  const sitemap = acts.find((a) => a.name === 'api_sitemap_crawler')
  assert.equal(sitemap.schema.shape.limit.kind, 'int')
  assert.equal(sitemap.schema.shape.limit.optional, true)
  assert.equal(typeof sitemap.schema.shape.url.optional, 'function', 'required param is not wrapped in optional()')
  assert.match(await sitemap.invoke({ url: 'https://x.org' }), /api_sitemap_crawler/)
})

test('Virtuals GAME adapter coerces string args and maps results to Done/Failed', async () => {
  class GameFunction { constructor(o) { Object.assign(this, o) } }
  class Resp { constructor(status, feedback) { this.status = status; this.feedback = feedback } }
  const Status = { Done: 'done', Failed: 'failed' }
  let seen
  const client = { call: async (n, a) => { seen = a; if (a.limit === 13) throw new Error('boom'); return { data: { ok: 1 } } } }
  const fns = gameFunctions({ client, GameFunction, ExecutableGameFunctionResponse: Resp, ExecutableGameFunctionStatus: Status, tools: ['api_sitemap_crawler'] })
  const fn = fns[0]
  assert.deepEqual(fn.args.map((a) => [a.name, a.optional]), [['url', false], ['limit', true]])
  const ok = await fn.executable({ url: 'https://x.org', limit: '5' })
  assert.equal(ok.status, 'done')
  assert.deepEqual(seen, { url: 'https://x.org', limit: 5 })
  const bad = await fn.executable({ url: 'https://x.org', limit: '13' })
  assert.equal(bad.status, 'failed')
  assert.match(bad.feedback, /boom/)
})
