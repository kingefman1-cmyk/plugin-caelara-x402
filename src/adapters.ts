import { createCaelaraClient, getTool, type CaelaraClient } from './client.js'
import { TOOLS } from './tools.generated.js'
import type { ClientOptions, ToolDef } from './types.js'

// Adapters are structural: they build the objects each framework expects without importing the framework,
// so this package keeps just two runtime dependencies (x402-fetch, viem). Shapes were checked against:
//   ElizaOS  @elizaos/core 2.0.x  Action { name, description, similes, parameters[], validate, handler -> ActionResult }
//   AgentKit @coinbase/agentkit   customActionProvider([{ name, description, schema (zod), invoke }])
//   Virtuals @virtuals-protocol/game (game-node)  GameFunction { name, description, args[], executable -> ExecutableGameFunctionResponse }

export interface SelectOptions {
  /** Only these suites, e.g. ['crypto', 'agent']. Default: all 10. */
  suites?: string[]
  /** Only these tool names (`<suite>_<tool>`). Takes precedence over suites. */
  tools?: string[]
}

export function selectTools(sel: SelectOptions = {}): ToolDef[] {
  if (sel.tools?.length) return sel.tools.map(getTool)
  if (sel.suites?.length) return TOOLS.filter((t) => sel.suites!.includes(t.suite))
  return [...TOOLS]
}

const summarize = (data: unknown, limit = 1800): string => {
  const s = typeof data === 'string' ? data : JSON.stringify(data)
  return s.length > limit ? s.slice(0, limit) + ' …(truncated)' : s
}

// ---------- ElizaOS ----------
export interface ElizaPluginOptions extends SelectOptions, ClientOptions {
  /** Use this client instead of building one from the runtime settings. */
  client?: CaelaraClient
  /** Read the 402 terms instead of paying. Actions then report the price and what would be paid, and spend nothing. */
  dryRun?: boolean
}

export interface RuntimeLike { getSetting?: (key: string) => string | boolean | null | undefined }
type Params = Record<string, unknown>

function pickParams(tool: ToolDef, options: unknown, message: unknown): Params {
  const names = new Set(tool.params.map((p) => p.name))
  const o = options as { parameters?: Params } | Params | undefined
  const fromOpts = (o && typeof o === 'object' && 'parameters' in o && o.parameters ? (o.parameters as Params) : (o as Params | undefined)) ?? {}
  const out: Params = {}
  for (const [k, v] of Object.entries(fromOpts)) if (names.has(k) && v !== undefined && v !== null) out[k] = v
  if (Object.keys(out).length) return out
  const text = (message as { content?: { text?: string } } | undefined)?.content?.text?.trim()
  if (text?.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Params
      for (const [k, v] of Object.entries(j.arguments && typeof j.arguments === 'object' ? (j.arguments as Params) : j)) if (names.has(k)) out[k] = v
    } catch { /* not JSON */ }
  }
  return out
}

export function elizaActions(options: ElizaPluginOptions = {}) {
  const tools = selectTools(options)
  const clients = new WeakMap<object, CaelaraClient>()
  const fallback: { c?: CaelaraClient } = {}
  const setting = (rt: RuntimeLike | undefined, k: string) => {
    const v = rt?.getSetting?.(k)
    return typeof v === 'string' && v ? v : process.env[k]
  }
  const clientFor = (rt: RuntimeLike | undefined): CaelaraClient => {
    if (options.client) return options.client
    const key = options.privateKey ?? setting(rt, 'CAELARA_PRIVATE_KEY')
    const max = options.maxUsdc ?? (setting(rt, 'CAELARA_MAX_USDC') ? Number(setting(rt, 'CAELARA_MAX_USDC')) : undefined)
    const build = () => createCaelaraClient({ ...options, privateKey: key, maxUsdc: max })
    if (rt && typeof rt === 'object') {
      let c = clients.get(rt)
      if (!c) { c = build(); clients.set(rt, c) }
      return c
    }
    return (fallback.c ??= build())
  }
  const dry = (rt: RuntimeLike | undefined) => options.dryRun ?? setting(rt, 'CAELARA_DRY_RUN') === 'true'

  return tools.map((tool) => {
    const name = `CAELARA_${tool.suite}_${tool.tool}`.toUpperCase()
    return {
      name,
      similes: [tool.tool.toUpperCase(), `CAELARA_${tool.tool}`.toUpperCase()],
      description: `${tool.summary}. Caelara Labs ${tool.suite} suite, ${tool.priceUsdc} USDC per call on Base via x402.`,
      parameters: tool.params.map((p) => ({ name: p.name, description: p.description, required: p.required, schema: { type: p.type } })),
      // Offered only when the agent can actually pay (a key is configured) or is in dry-run mode.
      validate: async (runtime: RuntimeLike) => Boolean(options.client || options.privateKey || setting(runtime, 'CAELARA_PRIVATE_KEY') || dry(runtime)),
      handler: async (
        runtime: RuntimeLike,
        message: unknown,
        _state?: unknown,
        handlerOptions?: unknown,
        callback?: (response: { text: string; source?: string; data?: unknown }, actionName?: string) => Promise<unknown>,
      ) => {
        try {
          const args = pickParams(tool, handlerOptions, message)
          const client = clientFor(runtime)
          if (dry(runtime)) {
            const r = await client.dryRun(tool.name, args)
            const text = `Dry run for ${tool.name}: ${r.terms ? `${r.terms.priceUsdc} USDC on ${r.terms.network} to ${r.terms.payTo}` : r.note}. Nothing was paid.`
            await callback?.({ text, source: 'caelara-x402', data: r }, name)
            return { success: true, text, data: r as unknown as Record<string, unknown> }
          }
          const r = await client.call(tool.name, args)
          const text = `${tool.tool} (${r.priceUsdc ?? 0} USDC${r.receipt?.basescan ? `, receipt ${r.receipt.basescan}` : ''}): ${summarize(r.data)}`
          await callback?.({ text, source: 'caelara-x402', data: r.data }, name)
          return { success: true, text, data: r as unknown as Record<string, unknown> }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await callback?.({ text: `Caelara ${tool.tool} failed: ${msg}`, source: 'caelara-x402' }, name)
          return { success: false, error: msg, text: msg }
        }
      },
      examples: [] as unknown[][],
    }
  })
}

/** ElizaOS plugin object: `{ name, description, actions }`. Register it in your character's plugins. */
export function createElizaPlugin(options: ElizaPluginOptions = {}) {
  const actions = elizaActions(options)
  return {
    name: 'caelara-x402',
    description: `Caelara Labs edge APIs (${actions.length} actions) paid per call in USDC on Base via x402, with a hard per-call spending cap.`,
    actions,
    providers: [] as unknown[],
    evaluators: [] as unknown[],
    services: [] as unknown[],
  }
}

// ---------- Coinbase AgentKit ----------
interface ZodLike {
  string(): any; number(): any; boolean(): any; array(x: any): any; any(): any; record(a: any, b?: any): any; object(shape: Record<string, unknown>): any
}

/** Inputs for `customActionProvider([...])`. Pass your own `z` (zod) so this package needs no zod dependency. */
export function agentKitActions(opts: { z: ZodLike; client: CaelaraClient } & SelectOptions) {
  const { z, client } = opts
  return selectTools(opts).map((tool) => {
    const shape: Record<string, unknown> = {}
    for (const p of tool.params) {
      let s: any
      switch (p.type) {
        case 'integer': s = z.number().int(); break
        case 'number': s = z.number(); break
        case 'boolean': s = z.boolean(); break
        case 'array': s = z.array(z.any()); break
        case 'object': s = z.record(z.string(), z.any()); break
        default: s = z.string()
      }
      s = s.describe(p.description)
      shape[p.name] = p.required ? s : s.optional()
    }
    return {
      name: tool.name,
      description: `${tool.summary}. Caelara Labs ${tool.suite} suite, ${tool.priceUsdc} USDC per call on Base via x402.`,
      schema: z.object(shape),
      invoke: async (args: Record<string, unknown>) => {
        try {
          return summarize(await client.call(tool.name, args), 6000)
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }
      },
    }
  })
}

// ---------- Virtuals GAME SDK ----------
interface GameClasses {
  GameFunction: new (o: any) => unknown
  ExecutableGameFunctionResponse: new (status: any, feedback: string) => unknown
  ExecutableGameFunctionStatus: { Done: any; Failed: any }
}

const coerce = (type: string, v: string): unknown => {
  if (type === 'integer') return Number.parseInt(v, 10)
  if (type === 'number') return Number(v)
  if (type === 'boolean') return v === 'true'
  if (type === 'array' || type === 'object') return JSON.parse(v)
  return v
}

/** GAME functions. Pass the classes from `@virtuals-protocol/game`; GAME passes every argument as a string, so values are coerced. */
export function gameFunctions(opts: { client: CaelaraClient } & GameClasses & SelectOptions) {
  const { client, GameFunction, ExecutableGameFunctionResponse: Resp, ExecutableGameFunctionStatus: Status } = opts
  return selectTools(opts).map((tool) =>
    new GameFunction({
      name: tool.name,
      description: `${tool.summary}. Caelara Labs ${tool.suite} suite, ${tool.priceUsdc} USDC per call on Base via x402.`,
      args: tool.params.map((p) => ({ name: p.name, description: p.description, type: 'string', optional: !p.required })),
      executable: async (args: Record<string, string>, logger?: (m: string) => void) => {
        try {
          const typed: Record<string, unknown> = {}
          for (const p of tool.params) if (args[p.name] !== undefined && args[p.name] !== '') typed[p.name] = coerce(p.type, args[p.name])
          const r = await client.call(tool.name, typed)
          logger?.(`${tool.name}: paid=${r.paid} ${r.receipt?.basescan ?? ''}`)
          return new Resp(Status.Done, summarize(r.data, 4000))
        } catch (e) {
          return new Resp(Status.Failed, e instanceof Error ? e.message : String(e))
        }
      },
    }),
  )
}
