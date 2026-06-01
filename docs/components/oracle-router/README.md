# Oracle Router

Rank: 3

Priority: Must-have

## Goal

Replace the current keeper-only price model with a layered oracle router that can combine mock prices, Pyth, Chainlink-style feeds, and DEX quotes. The router should provide a single normalized price object to the agent, risk engine, dashboard, and eval harness.

## Current Project Fit

Today:

- `keeper.ts` calls `MockDEX.setPrice`.
- `readPrice()` reads `MockDEX.price`.
- Dashboard reads `PriceSet` events.

This is excellent for a deterministic demo, but real protocols need market data with freshness, confidence, and fallback handling.

## Real Problems It Solves

- Stale prices.
- Oracle outages.
- DEX price manipulation.
- Mispriced trades due to low liquidity.
- Lack of confidence interval or freshness metadata.
- No separation between "simulated market price" and "trusted reference price."

## Integration Design

Add:

```text
agent/src/oracles/
  types.ts
  router.ts
  mockOracle.ts
  pythOracle.ts
  chainlinkOracle.ts
  dexQuoteOracle.ts
```

Normalized return type:

```ts
interface PriceSnapshot {
  pair: string;
  priceE18: bigint;
  source: "mock" | "pyth" | "chainlink" | "dex_quote";
  updatedAt: bigint;
  confidenceE18?: bigint;
  stale: boolean;
  raw?: unknown;
}
```

Router behavior:

1. Read preferred reference oracle.
2. Reject if stale.
3. Read DEX quote if available.
4. Compare DEX quote against reference.
5. Return a snapshot plus warnings.

## Pyth Path

Pyth uses a pull model on EVM. The docs explain that callers fetch price update data, pay `getUpdateFee`, call `updatePriceFeeds`, and then read a recent value with `getPriceNoOlderThan`. If the price is stale, reads can revert with `StalePrice`.

Best integration path:

- Start with off-chain Pyth Hermes price reads for agent/risk context.
- Later add on-chain Pyth update support only for flows that require price inside Solidity.
- Store `maxAgeSeconds` per feed.
- Fail closed when stale.

## Chainlink Path

Chainlink Data Feeds use proxy contracts and `latestRoundData()`. Chainlink docs recommend checking freshness via `updatedAt` and pausing or switching modes if the answer is too old.

Best integration path:

- Use Chainlink feeds where Mantle feed availability is confirmed.
- Prefer proxy contract reads over aggregator reads.
- Track heartbeat/deviation config from data.chain.link.
- Fail closed on stale/zero/negative values.

## Dashboard Implications

Add an Oracle Status card:

- source
- latest price
- updatedAt
- age
- stale/fresh badge
- DEX/oracle deviation
- confidence range if available

## Acceptance Criteria

- `readPrice()` can be replaced by `oracleRouter.getPrice(pair)`.
- MockDEX still works as a local/testnet source.
- Risk engine blocks stale oracle snapshots.
- Dashboard displays price source and freshness.
- Tests cover stale, missing, divergent, and fresh oracle cases.

## Resources

- Pyth EVM real-time data guide: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/evm
- Pyth price feeds on Mantle announcement: https://www.pyth.network/blog/pyth-price-oracle-on-mantle
- Chainlink Data Feeds docs: https://docs.chain.link/data-feeds
- Chainlink feed explorer: https://data.chain.link/feeds
- Mantle ETH/USD Chainlink feed page: https://data.chain.link/feeds/mantle/mantle/eth-usd
