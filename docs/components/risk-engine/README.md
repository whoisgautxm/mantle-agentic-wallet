# Risk Engine

Rank: 1

Priority: Must-have

## Goal

Turn the current lightweight `agent/src/policy.ts` preflight into a protocol-grade risk engine that blocks bad decisions before they reach `AgentVault.execute`.

This is the most technically necessary next component because every real-protocol integration increases the agent's blast radius. If we add real swaps, approvals, lending, or yield without expanding risk checks first, the demo becomes less credible and less safe.

## Current Project Fit

Today, `policy.ts` checks:

- vault pause state
- per-transaction MNT spend limit
- daily MNT spend limit
- vault MNT balance
- sell amount <= token balance

The Solidity vault also enforces target allowlist, per-transaction spend, daily spend, pause, and agent-only execution. That is a strong base, but real DeFi needs more checks because swaps and lending can fail without violating raw MNT spend limits.

## Real Problems It Solves

- Buying into stale or manipulated prices.
- Accepting too much slippage.
- Over-concentrating in one token or protocol.
- Repeatedly losing money due to overtrading.
- Submitting swaps whose DEX quote differs sharply from oracle price.
- Borrowing against collateral until liquidation risk is high.
- Leaving unsafe token approvals after a failed strategy.

## Integration Design

Add:

```text
agent/src/risk/
  engine.ts
  rules.ts
  types.ts
  slippage.ts
  exposure.ts
  oracle.ts
  drawdown.ts
```

Replace:

```ts
checkPolicy(decision, state)
```

with:

```ts
evaluateRisk({
  decision,
  vaultState,
  portfolio,
  protocolPlan,
  quote,
  oraclePrice,
  simulation,
  limits,
})
```

Return:

```ts
type RiskResult =
  | { ok: true; warnings: RiskWarning[] }
  | { ok: false; reason: string; ruleId: string; severity: "blocker" | "critical" };
```

## Minimum Rule Set

- `TARGET_ALLOWED`: target is allowlisted in `AgentVault`.
- `FUNCTION_ALLOWED`: calldata selector is allowed for that target.
- `PER_TX_SPEND`: value does not exceed spend limit.
- `DAILY_SPEND`: projected spend does not exceed daily limit.
- `MAX_SLIPPAGE`: `amountOutMinimum` or equivalent quote guard is within configured tolerance.
- `ORACLE_STALENESS`: oracle timestamp is fresh enough.
- `DEX_ORACLE_DEVIATION`: DEX quote is not too far from oracle price.
- `MAX_POSITION_SIZE`: token exposure does not exceed configured percentage of portfolio.
- `MAX_DAILY_LOSS`: soft breaker blocks new risky trades after daily drawdown.
- `SIMULATION_SUCCESS`: proposed transaction simulation passes.
- `NO_UNBOUNDED_APPROVAL`: approvals must be bounded unless explicitly whitelisted.

## Contract Implications

Short term: keep `AgentVault` as-is and enforce advanced risk off-chain before execution.

Medium term: add optional on-chain guardrails:

- allowed function selector mapping: `mapping(address => mapping(bytes4 => bool))`
- per-target spend limits
- per-token exposure caps where token addresses are known
- `RiskDecision` event with blocked/warned decisions

## Dashboard Implications

Add a Risk panel:

- latest risk status
- blocked decision count
- active circuit breakers
- oracle freshness
- slippage tolerance
- current exposure by token/protocol

## Acceptance Criteria

- A risky decision is blocked before `submitExecute`.
- The block reason is deterministic and test-covered.
- The dashboard can display the blocked reason.
- Existing MockDEX buy/sell tests still pass.
- A real-protocol adapter cannot submit a transaction without a `RiskResult.ok === true`.

## Suggested Tests

- Blocks stale oracle data.
- Blocks DEX quote > configured deviation from oracle.
- Blocks trade exceeding max portfolio exposure.
- Blocks missing `amountOutMinimum`.
- Blocks unknown function selector.
- Allows existing MockDEX DCA buy under current limits.

## Resources

- Chainlink Data Feeds freshness guidance: https://docs.chain.link/data-feeds
- Pyth stale price behavior and `getPriceNoOlderThan`: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/evm
- viem `simulateContract`: https://viem.sh/docs/contract/simulateContract
- OpenZeppelin access control: https://docs.openzeppelin.com/contracts/api/access
- OpenZeppelin security utilities: https://docs.openzeppelin.com/contracts/api/utils
