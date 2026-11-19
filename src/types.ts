export type Tier = 'atomic' | 'composite'

export interface ToolParam {
  name: string
  in: 'query' | 'body'
  type: string
  required: boolean
  description: string
}

export interface ToolDef {
  /** Unique tool id: `<suite>_<tool>`, e.g. `crypto_token_price_aggregator`. */
  name: string
  /** MCP tool name of the endpoint, e.g. `token_price_aggregator`. */
  tool: string
  suite: string
  host: string
  path: string
  method: 'GET' | 'POST'
  tier: Tier
  priceUsdc: string
  summary: string
  params: readonly ToolParam[]
}

export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
    additionalProperties: false
  }
}

export interface Terms {
  x402Version: number
  scheme: string
  network: string
  asset: string
  payTo: string
  priceUsdc: number
  atomicUnits: string
  resource: string
}

export interface DryRunResult {
  tool: string
  url: string
  httpStatus: number
  terms?: Terms
  note?: string
}

export interface CallResult {
  tool: string
  status: number
  paid: boolean
  priceUsdc?: number
  data: unknown
  receipt?: { success: boolean; network?: string; payer?: string; transaction?: string; basescan: string | null }
}

export interface ClientOptions {
  /** 0x-prefixed key of a DEDICATED wallet that holds a little USDC on Base. Not needed for dry runs. */
  privateKey?: string
  /** Hard cap per call in USDC. Default 0.025 (one composite call). Set 0.005 to allow atomic endpoints only. */
  maxUsdc?: number
  /** Required payTo address. Default: the Caelara treasury baked into the generated tool list. null disables the check. */
  payTo?: string | null
  /** Base RPC used to build the signing client. Default https://mainnet.base.org */
  rpcUrl?: string
  /** Inject fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Inject the x402-paying fetch factory (tests). Receives the cap in atomic USDC units. */
  paidFetchFactory?: (maxAtomic: bigint, privateKey: string) => Promise<{ fetch: typeof fetch; decode: (header: string) => any }>
}
