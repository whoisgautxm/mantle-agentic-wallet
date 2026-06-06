# Protocol Adapter Layer

Rank: 2

Priority: Must-have

## Goal

Move from a hardcoded MockDEX integration to a protocol adapter system that can support MockDEX, Merchant Moe, Uniswap-like routers, aggregators, and future protocols without letting the model produce arbitrary calldata.

## Current Project Fit

Implemented v1 now has an executable/read-only protocol registry in `agent/src/protocols/registry.ts`. The AI runner and baseline runner resolve MockDEX through that registry, while Merchant Moe remains a read-only adapter that cannot be retrieved as executable. Execution plans now carry normalized slippage/min-output/deadline metadata for future real DEX adapters.

The remaining next steps are richer adapter metadata for token pairs, dashboard protocol cards, and mainnet-fork simulation before any real adapter execution.

Earlier, `agent/src/dex.ts` directly exposed:

- `DEX_ABI`
- `encodeBuy()`
- `encodeSell(tokenAmountWei)`

That is perfect for a first demo, but it makes every venue look like MockDEX. A real DEX adapter should handle:

- protocol-specific ABIs
- quote functions
- calldata construction
- target addresses
- required token approvals
- min-output/slippage fields
- human-readable plan summaries

## Real Problems It Solves

- Different DEX routers use different calldata and quote semantics.
- Real swaps need `amountOutMinimum`, deadlines, paths, pool fees, or bins.
- Aggregators may route through multiple protocols.
- The agent needs a stable action interface even when execution protocols differ.
- Risk checks need normalized quote and execution metadata.

## Integration Design

Add:

```text
agent/src/protocols/
  types.ts
  registry.ts
  mockDexAdapter.ts
  merchantMoeAdapter.ts
  uniswapV3Adapter.ts
```

Core interface:

```ts
interface ProtocolAdapter {
  id: string;
  chainId: number;
  supportedActions: Array<"swap" | "supply" | "withdraw" | "borrow" | "repay">;
  quote(input: QuoteInput): Promise<QuoteResult>;
  buildPlan(input: ActionInput, quote: QuoteResult): Promise<ExecutionPlan>;
  decode?(txInput: `0x${string}`): DecodedAction;
}
```

Normalized execution plan:

```ts
interface ExecutionPlan {
  protocolId: string;
  target: `0x${string}`;
  valueWei: bigint;
  calldata: `0x${string}`;
  approvals: ApprovalPlan[];
  expectedOutWei?: bigint;
  minOutWei?: bigint;
  slippageBps?: bigint;
  deadlineSeconds?: bigint;
  summary: string;
}
```

## First Adapter Migration

Implemented v1 wraps current MockDEX behavior:

- `mockDexAdapter.quote()` reads `price()`.
- `mockDexAdapter.buildPlan()` returns `buy()` or `sell(uint256)` calldata.
- Existing `brain.ts` still lets the model propose `buy`, `sell`, or `hold`.
- `parseToolUseIntent()` returns intent, not calldata.
- The adapter converts intent into `ExecutionPlan`.
- `ExecutionPlan` includes `expectedOutWei`, `minOutWei`, `slippageBps`, and optional `deadlineSeconds`.

## Real Protocol Path

Merchant Moe is highly relevant because its docs describe it as a DEX built for Mantle with swapping, liquidity, farming, and Liquidity Book support. Its contracts page lists router, factory, aggregator, and Liquidity Book router/quoter addresses.

Important caution: published Merchant Moe contract addresses are for Mantle mainnet unless a page explicitly says otherwise. For this project, first integrate a read-only adapter and mainnet-fork simulation. Do not execute live mainnet trades until risk, oracle, approvals, and simulation are mature.

Implemented readiness step:

- `MERCHANT_MOE_ROUTE_PRESET` supports verified WMNT/stable quote presets: `wmnt-usdc-direct`, `wmnt-moe-usdc`, `wmnt-usdt-direct`, and `wmnt-usde-direct`.
- Presets include token route, decimals, default 0.1 WMNT test size, Pyth MNT/USD reference mode, and route-specific deviation thresholds.
- `npm run readiness:merchant-moe` quotes the configured route, computes min-output from slippage, checks quote/reference deviation, reports fork RPC status, writes JSONL trace evidence, and blocks live execution.
- `npm run simulate:merchant-moe-fork` adds the Phase C fork-simulation gate. It blocks until fork RPC and simulation account are configured, then builds simulation-only LBRouter calldata from the quote metadata when no explicit calldata fixture is provided.
- ERC20 preflight reads token-in balance and LBRouter allowance before the router call, blocking insufficient state before protocol simulation.
- `npm run simulate:merchant-moe-fixture` runs a deterministic controlled fixture that passes quote, oracle/reference, calldata, balance, allowance, and injected simulation gates while keeping live execution disabled.
- Fork simulation can run as a direct LBRouter call or fork-local `AgentVault.execute` call without submitting transactions.
- The dashboard reads the latest Merchant Moe quote-smoke, fork-readiness, or fork-simulation JSONL trace event and surfaces route, output, min-output, slippage, quote-risk, simulation status, blockers, and next steps.

## Dashboard Implications

Show:

- protocol name per decision
- action type
- token in/out
- expected output
- slippage tolerance
- quote source
- tx target and function selector

Implemented dashboard evidence:

- Merchant Moe trace card for read-only quote, fork-readiness, and fork-simulation reports.
- Real DEX blocker/next-step feed so demo viewers can see why execution remains disabled.

## Acceptance Criteria

- MockDEX behavior works through the adapter interface. Implemented in `agent/src/protocols/mockDexAdapter.ts`.
- `brain.ts` no longer imports DEX-specific calldata encoders directly.
- Every execution plan has a protocol ID, target, calldata, value, and summary.
- Risk engine receives registry-derived target and selector guard metadata.
- Tests prove unknown, duplicate, and read-only adapters cannot execute.

## Resources

- Merchant Moe overview: https://docs.merchantmoe.com/
- Merchant Moe contracts: https://docs.merchantmoe.com/resources/contracts
- Merchant Moe trading docs: https://docs.merchantmoe.com/dex-features/trading
- Uniswap v3 single-hop swap guide: https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping
- viem ABI encoding: https://viem.sh/docs/contract/encodeFunctionData
