# Real DeFi Problem Statement

Research date: 2026-06-03

## One-Line Thesis

Autonomous DeFi agents should not be judged by whether they can click `swap`; they should be judged by whether they can operate a real on-chain wallet under verifiable risk constraints, across real protocol data, with every decision reproducible against a human baseline.

## Precise Problem

DeFi is increasingly composable, but safe autonomy is still missing. A user can delegate an AI agent to monitor markets, rebalance, swap, lend, or harvest yield, but today's agent demos usually fail at the parts that matter in production:

- The model can propose arbitrary or malformed calldata.
- A profitable-looking action may revert, be stale, exceed exposure limits, or rely on manipulated DEX prices.
- The user cannot easily inspect why an agent acted, why it held, or why it was blocked.
- Real protocols require token balances, ERC20 approvals, router allowlists, oracle freshness, slippage limits, liquidation health, and failure simulation.
- There is no standard benchmark proving whether an AI strategy is safer or better than a simple deterministic baseline.

This project should become a benchmarkable autonomous DeFi wallet: not an AI trading toy, but a safety-first agent execution layer that can graduate from MockDEX to Mantle-native protocols without losing auditability.

## User Pain

### Retail DeFi User

Retail users want automated strategies but cannot continuously monitor oracle staleness, position exposure, lending health, or router approvals. They need an agent that can act, but only inside boundaries they can understand.

### DeFi Protocol

Protocols want agentic liquidity and strategy automation, but unsafe agents create bad UX: reverted transactions, excess approvals, poor slippage, and liquidation mistakes. They need integration-ready adapters and observable risk checks.

### Hackathon Judge / Evaluator

Judges do not just need to see an AI make one transaction. They need evidence that the agent can be compared against a baseline, audited from events, and extended into real DeFi safely.

## Reframed Project

Current simple framing:

> An AI wallet trades against a MockDEX and compares itself with a DCA baseline.

Stronger real-world framing:

> A guarded autonomous DeFi wallet that turns model intent into simulated, risk-scored, protocol-aware execution plans, then benchmarks the outcome against deterministic human strategies using on-chain evidence.

## Real-World Protocol Fit

### 1. Merchant Moe: Mantle-Native DEX Execution Path

Merchant Moe describes itself as a Mantle DEX with trading, liquidity pools, farming, staking, gauges, and Liquidity Book support. This makes it the natural first real DEX target.

Current project state:

- Merchant Moe read-only LBQuoter adapter exists.
- Merchant Moe read-only quote smoke CLI exists.
- Merchant Moe quote smoke can report quote-vs-reference deviation when decimals and a manual or Pyth reference are configured.
- Merchant Moe quote smoke writes JSONL trace events for replay and reports.
- Merchant Moe fork-readiness CLI computes min-output/slippage metadata and blocks execution while calldata is disabled.
- Merchant Moe fork-simulation CLI writes JSONL evidence and blocks until fork RPC, simulation account, and swap calldata are configured.
- Merchant Moe route presets harden WMNT/stable routes with verified token addresses, decimals, Pyth MNT/USD reference mode, and quote deviation thresholds.
- Merchant Moe execution is intentionally disabled.
- ERC20 allowance tracking can watch the LB Router spender.
- Protocol readiness dashboard shows read-only/execution status.

Next integration:

1. Keep expanding verified token route config for WMNT/stables and other Mantle pairs.
2. Build eval runners that replay JSONL traces and grade policy obedience.
3. Add safe LBRouter calldata fixture/builder and run it through mainnet-fork simulation.
4. Only then consider guarded live execution.

Primary risk questions:

- Is the quote fresh and liquid enough?
- Does Pyth/reference price deviate from the DEX quote?
- Is the router allowance bounded?
- Does the swap simulate successfully from the vault?
- Is the expected output above min-output after slippage?

### 2. Pyth: External Price Reference

Pyth/Hermes gives the project a real external price reference. This matters because a DeFi agent should not trust the same DEX it is about to trade against as its only source of truth.

Current project state:

- Read-only Pyth Hermes MNT/USD oracle exists.
- Dashboard can show active, standby, stale, or fallback state.
- Risk engine already blocks stale oracle snapshots.
- Agent and baseline JSONL traces preserve oracle, quote, risk, simulation, and final-action evidence for evals.
- Trace eval runner grades local JSONL traces for policy obedience.
- Scenario eval runner grades deterministic stale-oracle, failed-simulation, bad-target, safe-buy, and oversized-trade cases.
- Dashboard replay benchmark cards surface trace/scenario eval artifacts for reports and demos.

Next integration:

1. Add more feed IDs for assets used in real routes.
2. Track confidence interval as a risk input.
3. Make DEX quote deviation block execution per asset pair.
4. Show oracle age/confidence/deviation in decision logs and evals.

Primary risk questions:

- Is the reference price stale?
- Is confidence too wide?
- Does DEX output deviate beyond configured basis points?
- Is fallback mode allowed for execution or read-only observation only?

### 3. Lendle: Money-Market Readiness

Lendle is a Mantle-native non-custodial lending market. Lending creates more realistic DeFi problems than swapping because the agent must reason about deposits, borrow rates, health factor, liquidation, and collateral.

Current project state:

- Lending health-factor evaluator exists for read-only local snapshots.
- Lending readiness CLI writes `lending.readiness` JSONL trace evidence.
- Dashboard surfaces supplied value, debt value, weighted liquidation threshold, health factor, liquidation buffer, blockers, and next steps.
- Lending execution is intentionally disabled.

Best fit for this project:

- Start read-only.
- Show account health, supplied assets, borrowed assets, and liquidation buffer.
- Do not borrow until health-factor simulation and oracle support are mature.

Primary risk questions:

- Is health factor above a strict minimum after action?
- Is the supplied collateral asset supported and liquid?
- Is borrow APR or liquidation risk too high?
- Is oracle data fresh for every collateral and debt asset?

### 4. INIT Capital: Advanced Liquidity Hook / Strategy Path

INIT Capital is more advanced: its developer docs describe multi-silo positions, modes, and Liquidity Hooks that let integrated protocols use INIT liquidity and perform external contract calls, with health checked at the end.

Best fit for this project:

- Treat INIT as the "advanced track," not the first live execution target.
- Start by reading position/mode/risk metadata.
- Later support simulated hook interactions.
- Use it to demonstrate the project can reason about complex composable DeFi, not just swaps.

Primary risk questions:

- Which position/mode is active?
- Which collateral and borrow tokens are allowed?
- What is the post-hook health state?
- Which external calls happen inside the hook?
- Can the full multicall/hook path be simulated?

## Product Wedge

The strongest hackathon wedge is:

> "A Turing Test for DeFi agents: can an AI wallet outperform or out-risk-manage a human baseline while every action is bounded by contracts, simulated before execution, validated by external oracle data, and replayable from chain events?"

This makes the project more than a trading bot. It becomes:

- an autonomous wallet,
- a safety layer,
- a protocol adapter framework,
- a benchmark harness,
- and a DeFi observability dashboard.

## Architecture Target

```text
Model intent
  -> intent parser
  -> protocol adapter registry
  -> quote / read-only protocol data
  -> oracle router
  -> ERC20 balance + allowance layer
  -> risk engine
  -> simulation engine
  -> AgentVault.execute
  -> on-chain events
  -> dashboard + eval dataset
```

## Development Phases

### Phase A: Make Real Readiness Visible

Status: mostly implemented.

- Protocol readiness dashboard.
- Pyth/Merchant Moe read-only statuses.
- Simulation gate visibility.
- Allowance watch readiness.
- Demo orchestrator starts/stops the local keeper, AI, baseline, dashboard, and eval summaries with duplicate-process protection.

### Phase B: Real Quotes, No Execution

Goal: prove real protocol compatibility without risking funds.

- Merchant Moe quote smoke CLI.
- Pyth reference comparison for real token pairs.
- Merchant Moe fork-readiness reports for slippage/min-output and execution blockers.
- Dashboard quote card.
- JSON decision trace for every agent tick.

### Phase C: Mainnet-Fork Simulation

Goal: make real execution paths testable without live execution.

- Fork Mantle mainnet.
- Simulate Merchant Moe swap path from a vault-like account. V1 harness implemented for provided calldata.
- Validate router approvals, calldata, min output, and gas. V1 records precondition blockers, gas, and revert reasons.
- Add regression tests for failed slippage/stale oracle cases.

### Phase D: Read-Only Lending Risk

Goal: graduate beyond swaps into real DeFi risk.

- Lendle read-only account/market adapter.
- INIT read-only position/mode adapter.
- Health factor, borrow cap, liquidation buffer, and APR display.
- No live borrow/repay yet.

### Phase E: Guarded Real Execution

Goal: enable small, bounded live execution only after read-only + fork checks pass.

- Per-protocol allowlists.
- Bounded ERC20 approvals.
- Slippage/min-output.
- Simulation required.
- Emergency pause.
- Structured decision logs.
- Optional multisig owner controls.

## What Not To Do Yet

- Do not enable Merchant Moe live swaps before fork simulation.
- Do not add borrowing before lending health checks are read-only and tested.
- Do not let the model choose arbitrary protocols, token addresses, or calldata.
- Do not treat fallback oracle data as safe for execution unless policy explicitly allows it.
- Do not optimize for high PnL before proving policy obedience and failure handling.

## Success Criteria

The project is no longer beginner-level when it can show:

- Real protocol quotes from Merchant Moe.
- External reference prices from Pyth.
- Token balance and allowance visibility.
- A simulation gate before every transaction.
- Risk blocks for stale oracle, excessive exposure, bad target, bad selector, bad simulation, and DEX/oracle deviation.
- A dashboard explaining not just what happened, but whether the agent was allowed to act.
- A deterministic baseline and replayable event history.
- A path to lending/liquidation risk via Lendle or INIT without jumping straight into unsafe execution.

## Primary Sources

- Merchant Moe docs: https://docs.merchantmoe.com/
- Merchant Moe contracts: https://docs.merchantmoe.com/resources/contracts
- Pyth price updates: https://docs.pyth.network/price-feeds/core/fetch-price-updates
- Pyth price feed IDs: https://docs.pyth.network/price-feeds/core/price-feeds/price-feed-ids
- Lendle docs: https://docs.lendle.xyz/
- INIT developer docs: https://dev.init.capital/
- INIT Mantle contract addresses: https://docs.init.capital/additional-information/contract-address/mantle
- INIT Liquidity Hook guide: https://dev.init.capital/guides/liquidity-hook/looping-hook
