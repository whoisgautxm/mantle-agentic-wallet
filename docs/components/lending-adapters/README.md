# Lending and Yield Adapters

Rank: 6

Priority: High

## Goal

Expand the agent beyond swaps into lending/yield decisions: supply, withdraw, borrow, repay, and monitor collateral health.

This component should come after risk, oracle, simulation, and ERC20 portfolio support because lending protocols introduce liquidation and collateral-risk failure modes.

## Current Project Fit

The current benchmark compares AI trading vs DCA. Lending adapters would add a second benchmark dimension:

- Can the AI preserve capital better than DCA?
- Can it identify when idle MNT/stables should earn yield?
- Can it avoid liquidation risk?
- Can it explain risk-adjusted yield decisions?

## Relevant Mantle Protocols

Lendle describes itself as a decentralized, non-custodial lending market built on Mantle. Its docs include concepts such as markets, health factor, liquidations, L-tokens, and deployed Mantle contracts.

INIT Capital describes a non-custodial lending protocol with multi-silo positions, modes, and liquidity hooks. This is more complex but highly relevant to "real DeFi problems" because it introduces isolated position accounting and hook-based strategies.

## Real Problems It Solves

- Collateral health factor monitoring.
- Interest-rate and utilization changes.
- Borrow caps and supply caps.
- Liquidation thresholds.
- Withdrawal failure when utilization is too high.
- Reward APR vs base APY tradeoffs.
- Isolated vs cross-margin position risk.

## Integration Design

Add:

```text
agent/src/protocols/lending/
  types.ts
  lendleAdapter.ts
  initAdapter.ts
  health.ts
```

Adapter interface:

```ts
interface LendingAdapter {
  id: string;
  readMarkets(): Promise<LendingMarket[]>;
  readPosition(vault: `0x${string}`): Promise<LendingPosition>;
  buildSupply(input: SupplyInput): Promise<ExecutionPlan>;
  buildWithdraw(input: WithdrawInput): Promise<ExecutionPlan>;
  buildBorrow(input: BorrowInput): Promise<ExecutionPlan>;
  buildRepay(input: RepayInput): Promise<ExecutionPlan>;
}
```

## First Implementation Slice

Start read-only:

- market list
- deposit APY/APR
- borrow APY/APR
- utilization
- health factor
- supplied balances
- debt balances

Then add execution only for supply/withdraw. Borrow/repay should wait until health-factor risk tests are mature.

## Risk Rules Needed First

- minimum health factor
- max borrow utilization
- max debt by token
- max protocol exposure
- no borrow without oracle freshness
- no borrow if liquidation threshold cannot be computed
- no supply if reserve is paused/frozen/capped
- no withdraw if projected health factor falls below threshold

## Dashboard Implications

Add:

- lending market cards
- current APY/APR
- health factor
- liquidation threshold
- supplied/debt amounts
- blocked borrow reasons

## Acceptance Criteria

- Read-only market and position display works before execution.
- Risk engine blocks unsafe borrow/withdraw.
- Simulation passes before any supply/withdraw.
- Dashboard explains health factor and liquidation risk.
- No borrow execution is enabled until tests cover liquidation edge cases.

## Resources

- Lendle docs: https://docs.lendle.xyz/
- Lendle Mantle contracts: https://docs.lendle.xyz/contracts-and-security/mantle-contracts
- Lendle health factor docs: https://docs.lendle.xyz/key-protocol-insights/health-factor
- Lendle liquidations and flashloans: https://docs.lendle.xyz/key-protocol-insights/liquidations-and-flashloans
- INIT Capital developer docs: https://dev.init.capital/
- INIT liquidity hooks: https://docs.init.capital/for-dapps/building-liquidity-hook
