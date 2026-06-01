# Protocol Adapter Layer

Rank: 2

Priority: Must-have

## Goal

Move from a hardcoded MockDEX integration to a protocol adapter system that can support MockDEX, Merchant Moe, Uniswap-like routers, aggregators, and future protocols without letting the model produce arbitrary calldata.

## Current Project Fit

Today, `agent/src/dex.ts` directly exposes:

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
  deadline?: bigint;
  summary: string;
}
```

## First Adapter Migration

Start by wrapping current MockDEX behavior:

- `mockDexAdapter.quote()` reads `price()`.
- `mockDexAdapter.buildPlan()` returns `buy()` or `sell(uint256)` calldata.
- Existing `brain.ts` can keep proposing `buy`, `sell`, or `hold`.
- `parseToolUse()` should return intent, not calldata.
- Adapter converts intent into `ExecutionPlan`.

## Real Protocol Path

Merchant Moe is highly relevant because its docs describe it as a DEX built for Mantle with swapping, liquidity, farming, and Liquidity Book support. Its contracts page lists router, factory, aggregator, and Liquidity Book router/quoter addresses.

Important caution: published Merchant Moe contract addresses are for Mantle mainnet unless a page explicitly says otherwise. For this project, first integrate a read-only adapter and mainnet-fork simulation. Do not execute live mainnet trades until risk, oracle, approvals, and simulation are mature.

## Dashboard Implications

Show:

- protocol name per decision
- action type
- token in/out
- expected output
- slippage tolerance
- quote source
- tx target and function selector

## Acceptance Criteria

- MockDEX behavior works through the adapter interface.
- `brain.ts` no longer imports DEX-specific calldata encoders directly.
- Every execution plan has a protocol ID, target, calldata, value, and summary.
- Risk engine receives normalized quote and plan metadata.
- Tests prove unknown adapters/actions cannot execute.

## Resources

- Merchant Moe overview: https://docs.merchantmoe.com/
- Merchant Moe contracts: https://docs.merchantmoe.com/resources/contracts
- Merchant Moe trading docs: https://docs.merchantmoe.com/dex-features/trading
- Uniswap v3 single-hop swap guide: https://developers.uniswap.org/docs/protocols/v3/guides/swapping/single-hop-swapping
- viem ABI encoding: https://viem.sh/docs/contract/encodeFunctionData
