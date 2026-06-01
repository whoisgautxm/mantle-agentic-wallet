# Dashboard Analytics

Rank: 8

Priority: Medium-high

## Goal

Upgrade the dashboard from "demo replay" to "DeFi mission control" by showing protocol, oracle, risk, execution, and eval state.

## Current Project Fit

The dashboard currently reads:

- `AgentDecision`
- `PriceSet`
- `Bought`
- `Sold`

It reconstructs:

- price history
- AI token value
- baseline token value
- AI and baseline decision feeds

This should remain the foundation. New components should extend event sources and metadata, not replace the replay model.

## Real Problems It Solves

- Real protocol actions are harder to interpret than MockDEX buys/sells.
- Users need to see why a decision was blocked.
- Oracle freshness and deviation are invisible.
- Slippage and simulation results are invisible.
- PnL needs realized vs unrealized breakdown.
- Human-vs-AI comparison needs eval summaries, not just feeds.

## Integration Design

Add:

```text
web/app/components/
  RiskPanel.tsx
  OraclePanel.tsx
  PortfolioTable.tsx
  ProtocolCard.tsx
  SimulationFeed.tsx
  EvalSummary.tsx

web/lib/
  riskEvents.ts
  oracleSnapshots.ts
  portfolio.ts
  protocolMetadata.ts
```

## Event/Data Sources

Short term:

- on-chain vault and MockDEX logs
- local JSONL monitoring/eval logs
- `shared/addresses.json`
- static token/protocol registry

Medium term:

- on-chain risk/oracle events
- external indexer/subgraph
- protocol read calls
- explorer links and tx receipts

## Panels to Add

- Oracle Status: source, price, age, stale flag, DEX deviation.
- Risk Status: current breakers, blocked decisions, risk thresholds.
- Protocol Exposure: per protocol and per token values.
- Simulation Feed: latest proposed tx, gas estimate, pass/fail.
- Allowance Watch: spender, token, allowance, risk label.
- Eval Summary: scenario pass rate, policy obedience, PnL vs baseline.

## Acceptance Criteria

- Existing dashboard still works with only MockDEX events.
- New panels gracefully show empty states when components are not enabled.
- Every explorer link is derived from chain ID and tx hash/address.
- Dashboard avoids Alchemy log-limit failures through chunking/lookback controls.

## Resources

- Recharts docs: https://recharts.org/
- viem logs: https://viem.sh/docs/actions/public/getLogs
- Mantle Sepolia explorer: https://explorer.sepolia.mantle.xyz/
- Alchemy Mantle Sepolia RPC: https://www.alchemy.com/rpc/mantle-sepolia
