export { createCaelaraClient, buildRequest, getTool, toolSchema, toolSchemas, toOpenAITools, DEFAULT_MAX_USDC } from './client.js'
export type { CaelaraClient } from './client.js'
export { createElizaPlugin, elizaActions, agentKitActions, gameFunctions, selectTools } from './adapters.js'
export type { ElizaPluginOptions, SelectOptions, RuntimeLike } from './adapters.js'
export { TOOLS, PAY_TO, USDC_BASE, PRICES_USDC, CATALOG_COUNTS } from './tools.generated.js'
export type { ToolDef, ToolSchema, ToolParam, ClientOptions, CallResult, DryRunResult, Terms, Tier } from './types.js'

import { createElizaPlugin } from './adapters.js'
/** Default export for ElizaOS plugin loaders: all 100 actions, key read from CAELARA_PRIVATE_KEY. */
export default createElizaPlugin()
