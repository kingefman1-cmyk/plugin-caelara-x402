import { PAY_TO, TOOLS, USDC_BASE } from './tools.generated.js'
import type { CallResult, ClientOptions, DryRunResult, Terms, ToolDef, ToolSchema } from './types.js'

export const DEFAULT_MAX_USDC = 0.025 // one composite call; atomic calls are 0.005

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDef {
  const t = BY_NAME.get(name)
  if (!t) throw new Error(`unknown tool "${name}"`)
  return t
}

const typeOk = (type: string, v: unknown): boolean => {
  switch (type) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v)
    default: return typeof v === 'string'
  }
}

/** Validates arguments against the tool definition and builds the request URL / body. */
export function buildRequest(tool: ToolDef, args: Record<string, unknown> = {}): { url: string; method: 'GET' | 'POST'; body?: string } {
  const known = new Map(tool.params.map((p) => [p.name, p]))
  for (const k of Object.keys(args)) if (!known.has(k)) throw new Error(`${tool.name}: unknown argument "${k}"`)
  for (const p of tool.params) {
    const v = args[p.name]
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new Error(`${tool.name}: missing required argument "${p.name}"`)
      continue
    }
    if (!typeOk(p.type, v)) throw new Error(`${tool.name}: argument "${p.name}" must be of type ${p.type}`)
  }
  const query = new URLSearchParams()
  const body: Record<string, unknown> = {}
  for (const p of tool.params) {
    const v = args[p.name]
    if (v === undefined || v === null || v === '') continue
    if (p.in === 'query') query.set(p.name, typeof v === 'string' ? v : JSON.stringify(v))
    else body[p.name] = v
  }
  const q = query.toString()
  const url = `https://${tool.host}${tool.path}${q ? '?' + q : ''}`
  return tool.method === 'POST' ? { url, method: 'POST', body: JSON.stringify(body) } : { url, method: 'GET' }
}

export function toolSchema(tool: ToolDef): ToolSchema {
  return {
    name: tool.name,
    description: `${tool.summary}. ${tool.suite} suite. Costs ${tool.priceUsdc} USDC per call on Base (x402).`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((p) => [p.name, { type: p.type, description: p.description }])),
      required: tool.params.filter((p) => p.required).map((p) => p.name),
      additionalProperties: false,
    },
  }
}

export const toolSchemas = (tools: readonly ToolDef[] = TOOLS): ToolSchema[] => tools.map(toolSchema)
export const toOpenAITools = (tools: readonly ToolDef[] = TOOLS) => toolSchemas(tools).map((fn) => ({ type: 'function' as const, function: fn }))

export interface CaelaraClient {
  readonly tools: readonly ToolDef[]
  readonly maxUsdc: number
  /** Reads and validates the 402 terms of a call. Signs nothing, spends nothing, needs no key. */
  dryRun(name: string, args?: Record<string, unknown>): Promise<DryRunResult>
  /** Validates the terms, then pays and calls. Throws before signing if the terms are outside policy. */
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>
}

async function defaultPaidFetchFactory(maxAtomic: bigint, privateKey: string, rpcUrl: string) {
  const [{ wrapFetchWithPayment, decodeXPaymentResponse }, { createWalletClient, http }, { privateKeyToAccount }, { base }] = await Promise.all([
    import('x402-fetch'),
    import('viem'),
    import('viem/accounts'),
    import('viem/chains'),
  ])
  const client = createWalletClient({ account: privateKeyToAccount(privateKey as `0x${string}`), chain: base, transport: http(rpcUrl) })
  // x402-fetch gets the same cap as a second, independent limit.
  return { fetch: wrapFetchWithPayment(fetch, client as never, maxAtomic) as typeof fetch, decode: (h: string) => decodeXPaymentResponse(h) }
}

async function safeJson(res: Response): Promise<unknown> {
  const t = await res.text()
  try { return JSON.parse(t) } catch { return t }
}

export function createCaelaraClient(opts: ClientOptions = {}): CaelaraClient {
  const maxUsdc = opts.maxUsdc ?? Number(process.env.MAX_USDC || DEFAULT_MAX_USDC)
  if (!(maxUsdc > 0)) throw new Error('maxUsdc must be a positive number')
  const payTo = opts.payTo === undefined ? PAY_TO : opts.payTo
  const doFetch = opts.fetch ?? fetch
  const rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
  let paid: Promise<{ fetch: typeof fetch; decode: (h: string) => any }> | null = null
  const getPaid = () => {
    if (!opts.privateKey) throw new Error('privateKey is required to pay (use dryRun to inspect terms without one)')
    const factory = opts.paidFetchFactory ?? ((m: bigint, k: string) => defaultPaidFetchFactory(m, k, rpcUrl))
    return (paid ??= factory(BigInt(Math.round(maxUsdc * 1e6)), opts.privateKey))
  }

  async function readTerms(url: string, method: 'GET' | 'POST', body?: string): Promise<{ open: Response } | { terms: Terms }> {
    const res = await doFetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body, signal: AbortSignal.timeout(30000) })
    if (res.status !== 402) return { open: res }
    const json = (await res.json()) as { x402Version?: number; accepts?: Array<Record<string, string>> }
    const req = json.accepts?.[0]
    if (!req) throw new Error('402 response had no accepts[] entry')
    if (res.headers.get('x-payment-required') !== 'x402') throw new Error('missing X-Payment-Required: x402 header')
    const usdc = Number(req.maxAmountRequired) / 1e6
    if (req.network !== 'base') throw new Error(`refusing: network ${req.network}, expected base`)
    if (String(req.asset).toLowerCase() !== USDC_BASE.toLowerCase()) throw new Error(`refusing: asset ${req.asset} is not native USDC on Base`)
    if (payTo && String(req.payTo).toLowerCase() !== payTo.toLowerCase()) throw new Error(`refusing: payTo ${req.payTo} is not the pinned address ${payTo}`)
    if (!(usdc > 0 && usdc <= maxUsdc)) throw new Error(`refusing: ${usdc} USDC exceeds the maxUsdc cap of ${maxUsdc}`)
    return { terms: { x402Version: json.x402Version ?? 1, scheme: req.scheme, network: req.network, asset: req.asset, payTo: req.payTo, priceUsdc: usdc, atomicUnits: req.maxAmountRequired, resource: req.resource } }
  }

  return {
    tools: TOOLS,
    maxUsdc,
    async dryRun(name, args = {}) {
      const tool = getTool(name)
      const r = buildRequest(tool, args)
      const got = await readTerms(r.url, r.method, r.body)
      if ('open' in got) return { tool: name, url: r.url, httpStatus: got.open.status, note: 'endpoint answered without payment' }
      return { tool: name, url: r.url, httpStatus: 402, terms: got.terms }
    },
    async call(name, args = {}) {
      const tool = getTool(name)
      const r = buildRequest(tool, args)
      const pre = await readTerms(r.url, r.method, r.body)
      if ('open' in pre) return { tool: name, status: pre.open.status, paid: false, data: await safeJson(pre.open) }
      const p = await getPaid()
      const res = await p.fetch(r.url, { method: r.method, headers: r.body ? { 'content-type': 'application/json' } : undefined, body: r.body, signal: AbortSignal.timeout(60000) })
      const out: CallResult = { tool: name, status: res.status, paid: false, priceUsdc: pre.terms.priceUsdc, data: await safeJson(res) }
      const h = res.headers.get('x-payment-response')
      if (h) {
        const rc = p.decode(h)
        out.paid = !!rc.success
        out.receipt = { success: !!rc.success, network: rc.network, payer: rc.payer, transaction: rc.transaction, basescan: rc.transaction ? `https://basescan.org/tx/${rc.transaction}` : null }
      }
      if (!res.ok) throw Object.assign(new Error(`${name}: HTTP ${res.status}. A 402 here usually means the payment could not be verified (balance, network or signature).`), { result: out })
      return out
    },
  }
}
