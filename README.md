# plugin-caelara-x402

Caelara Labs edge APIs as agent tools: **100 endpoints in 10 suites**, paid per call in **USDC on Base** via [x402](https://github.com/coinbase/x402). No account and no API key. Includes a hard per-call spending cap and a pinned receiving address.

- ElizaOS plugin (`createElizaPlugin`), Coinbase AgentKit actions (`agentKitActions`), Virtuals GAME functions (`gameFunctions`) and plain JSON-Schema tool definitions (`toolSchemas`, `toOpenAITools`).
- Two runtime dependencies: `x402-fetch@1.2.0` and `viem`. The framework adapters are structural and import nothing from ElizaOS, AgentKit or GAME.
- The tool list is generated from the live catalog: https://caelaralabs.com/catalog.json

## How payment works

1. A call with no credentials gets `HTTP 402` with `X-Payment-Required: x402` and the terms (network `base`, native USDC, amount, `payTo`).
2. This package reads the terms and refuses anything outside policy **before signing**: wrong network, wrong asset, a `payTo` other than the pinned Caelara address, or an amount above `maxUsdc`.
3. `x402-fetch` signs an EIP-3009 USDC authorization and retries with `X-PAYMENT`. The payer signs but does not send a transaction, so **the wallet needs USDC on Base and no ETH**.
4. The server settles after a successful response. A failed call is not charged.

Prices: **$0.005 USDC** per atomic endpoint (80 of them), **$0.025 USDC** per composite endpoint (20).

`x402-fetch@1.2.0` speaks x402 v1, which these servers use. Upstream has deprecated that package in favour of v2 (`@x402/fetch`); the pinned version still works against v1 servers.

## Install

```bash
npm install plugin-caelara-x402
```

Use a **dedicated wallet** holding a few cents of USDC on Base. Never use a wallet that holds meaningful funds, and never commit its key.

## Quick start

```js
import { createCaelaraClient } from 'plugin-caelara-x402'

const caelara = createCaelaraClient({ privateKey: process.env.CAELARA_PRIVATE_KEY, maxUsdc: 0.025 })

// Read the 402 terms of any tool. No key, nothing signed, nothing spent.
console.log(await caelara.dryRun('crypto_token_price_aggregator', { symbol: 'ETH' }))

// Pay and call.
const r = await caelara.call('crypto_token_price_aggregator', { symbol: 'ETH' })
console.log(r.data, r.receipt?.basescan)
```

Tool names are `<suite>_<tool>`, for example `crypto_token_price_aggregator`, `api_url_to_markdown`, `agent_prompt_injection_scanner`. `TOOLS` lists all 100.

### Options

| Option | Default | Meaning |
|---|---|---|
| `privateKey` | none | 0x-prefixed key of the dedicated wallet. Not needed for `dryRun`. |
| `maxUsdc` | `0.025` (or `MAX_USDC`) | Hard cap per call. `0.005` allows atomic endpoints only. |
| `payTo` | Caelara treasury | The `payTo` the 402 terms must carry. `null` disables the check. |
| `rpcUrl` | `https://mainnet.base.org` | Base RPC for the signing client. |

## ElizaOS

```js
import { createElizaPlugin } from 'plugin-caelara-x402'

export const character = {
  // ...
  plugins: [createElizaPlugin({ suites: ['crypto', 'agent'] })],
  settings: { secrets: { CAELARA_PRIVATE_KEY: '0x...' } },
}
```

- Settings read from the runtime or the environment: `CAELARA_PRIVATE_KEY`, `CAELARA_MAX_USDC`, `CAELARA_DRY_RUN=true`.
- Actions are named `CAELARA_<SUITE>_<TOOL>` (for example `CAELARA_CRYPTO_TOKEN_PRICE_AGGREGATOR`) and declare `parameters` with schemas. Arguments are read from `options.parameters`, falling back to a JSON message.
- `validate` is true only when a key is configured or dry-run is on, so the agent is never offered an action it cannot pay for.
- All 100 actions can crowd a model's action list. Select what you need with `suites: [...]` or `tools: [...]`.
- The default export is a ready plugin with all 100 actions.

## Coinbase AgentKit

```js
import { z } from 'zod'
import { customActionProvider } from '@coinbase/agentkit'
import { createCaelaraClient, agentKitActions } from 'plugin-caelara-x402'

const client = createCaelaraClient({ privateKey: process.env.CAELARA_PRIVATE_KEY })
const provider = customActionProvider(agentKitActions({ z, client, suites: ['crypto'] }))
```

You pass your own `z`, so this package needs no zod dependency. The payer here is the key you give the client, not the AgentKit wallet.

## Virtuals GAME

```js
import { GameFunction, ExecutableGameFunctionResponse, ExecutableGameFunctionStatus } from '@virtuals-protocol/game'
import { createCaelaraClient, gameFunctions } from 'plugin-caelara-x402'

const fns = gameFunctions({ client: createCaelaraClient({ privateKey: process.env.CAELARA_PRIVATE_KEY }), GameFunction, ExecutableGameFunctionResponse, ExecutableGameFunctionStatus, suites: ['crypto'] })
```

GAME passes every argument as a string; the adapter coerces integers, booleans, arrays and objects by the tool's declared types.

## Any other framework

`toolSchemas()` returns `{ name, description, parameters }` JSON Schema for every tool, and `toOpenAITools()` wraps them as function tools. Dispatch with `client.call(name, args)`.

## Suites

| Suite | Host | Focus |
|---|---|---|
| api | api.caelaralabs.com | Company intel, lead verification, URL-to-markdown, SEO X-ray, MX forensics and sitemap crawling. |
| social | social.caelaralabs.com | Viral video audits, creator profiles, TikTok and YouTube metadata, hook scoring and engagement math. |
| agent | agent.caelaralabs.com | Input firewall, output validator, PII redaction, prompt-injection scanning, JSON repair and schema enforcement. |
| compliance | compliance.caelaralabs.com | Domain trust, entity KYB, SPF/DMARC grading, IBAN/VAT validation, sanctions screening and security-header audits. |
| ecom | ecom.caelaralabs.com | Product and storefront X-ray, JSON-LD parsing, GTIN validation, price-drop tracking and margin math. |
| seo | seo.caelaralabs.com | llms.txt and AI-crawler audits, redirect tracing, schema validation, SERP previews and link scanning. |
| docs | docs.caelaralabs.com | Invoice-to-JSON, universal data bridge, CSV/XML conversion, safe markdown, address and phone normalization. |
| crypto | crypto.caelaralabs.com | Token safety scoring, wallet portfolios, Solana mint audits, ERC-20 inspection, DEX depth and gas estimates. |
| geo | geo.caelaralabs.com | Timezone and scheduling math, public holidays, live FX, VAT/GST rates, postal validation and cross-border checkout. |
| media | media.caelaralabs.com | Open Graph and social cards, QR codes, color palettes, HD favicons, avatars, badges and image inspection. |

Each suite also publishes an A2A agent card (`/.well-known/agent.json`), an x402 manifest (`/.well-known/x402`), an OpenAPI spec and a remote MCP server (`com.caelaralabs/<suite>` in the Official MCP Registry). Index of all 10: https://caelaralabs.com/.well-known/agent.json

## Regenerate the tool list

```bash
npm run generate     # reads https://caelaralabs.com/catalog.json and the x402 manifest, writes src/tools.generated.ts
npm run build
```

## Tests

```bash
npm test             # build + 9 offline tests (mocked fetch, no network, no key)
npm run test:live    # all 100 tools: read the live 402 terms. No key, spends nothing.
```

What is verified, and what is not:

| Verified | Not verified |
|---|---|
| All 100 tools return valid, in-policy 402 terms from production (dry run) | A paid call made through this package. The paid path uses the same `x402-fetch` flow as the Caelara quickstart, whose $0.005 settlement is on Base: [basescan](https://basescan.org/tx/0xca1637a21ba8203c4044005a360c1b107cd75cd2625ee758ea7fe7c962b6982e) |
| The cap, network, asset and `payTo` checks refuse before anything is signed | Running inside a live ElizaOS, AgentKit or GAME runtime. The adapter shapes were checked against each project's source, not executed in it |
| Argument validation, ElizaOS action results, AgentKit schema building, GAME coercion (with fakes) | |

## Security

- The private key is used only to sign locally. It is never sent anywhere or logged.
- Keep `maxUsdc` as low as your use case allows and the wallet balance small.
- Report issues to ops@caelaralabs.com.

## License

MIT. See `LICENSE`.
