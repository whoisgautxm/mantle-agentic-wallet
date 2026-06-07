# Mantle Agentic Wallet Submission Readiness Report

Generated: June 7, 2026

## Executive Summary

The hackathon demo is submission-ready as a guarded, auditable Human-vs-AI DeFi benchmark. A real OpenAI agent and deterministic DCA baseline traded through separate `AgentVault` contracts on Mantle Sepolia, while the dashboard reconstructs price, trade, decision, risk, simulation, and portfolio evidence.

The latest verified replay favored the AI: **+25 bps** versus **-64 bps** for DCA, an **89 bps edge**, with lower maximum drawdown. The model-backed OpenAI judge scored the run **82/100** and found no stale-oracle or failed-simulation executions.

- Live dashboard: https://web-chi-sooty-61.vercel.app
- Repository: https://github.com/whoisgautxm/mantle-agentic-wallet
- Network: Mantle Sepolia (`5003`)

## Preview

![Dashboard preview](assets/submission-dashboard-preview.png)

![Mobile dashboard](assets/submission-dashboard-mobile.png)

![Full dashboard](assets/submission-dashboard-full.png)

## Verified Benchmark

| Result | OpenAI agent | DCA baseline |
|---|---:|---:|
| Completed ticks | 10 | 11 |
| Executed trades | 8 | 11 |
| Safely blocked trades | 2 | 0 |
| Portfolio return | **+25 bps** | -64 bps |
| Maximum drawdown | **-109 bps** | -250 bps |

OpenAI replay evaluation:

| Dimension | Score |
|---|---:|
| Overall | **82/100** |
| Safety | 88 |
| Decision quality | 73 |
| Evidence quality | 86 |
| AI-vs-baseline | 78 |

The two blocked AI actions exceeded the configured DEX/reference deviation threshold at 310 and 489 bps. No blocked action reached unsafe execution.

## Real Protocol Evidence

Merchant Moe was exercised against real Mantle mainnet contracts on disposable Anvil forks, not just mocked interfaces:

- WMNT to USDC quote and reference checks passed at fork block `96329880`.
- Router calldata was generated in code with bounded slippage and exact allowance.
- `AgentVault.execute` succeeded on the fork with gas estimate `183312`, execution gas `164775`, output delta `51285`, and one emitted `AgentDecision`.
- A five-case adversarial suite passed at block `96329905`.
- Paused vault, disallowed router, stale oracle, impossible minimum output, and unsafe allowance all stopped before an unsafe swap submission.

Live Mantle mainnet transaction submission remains deliberately disabled. The project proves the production-shaped execution path on a fork without putting real funds at risk.

## Delivered System

- Guarded Solidity vaults with target allowlists, spend limits, pause controls, nonce tracking, and decision events.
- OpenAI and Anthropic provider support, with the verified benchmark using OpenAI.
- Portfolio-aware action sizing that caps buys by balance and policy, caps sells by inventory, and converts impossible actions to `HOLD`.
- Deterministic DCA baseline for side-by-side evaluation.
- Structured JSONL traces covering observations, quotes, oracle checks, risk, simulation, and final actions.
- Deterministic scenario and trace evals plus model-backed OpenAI replay judging.
- Merchant Moe quote, calldata, allowance, simulation, fork execution, and adversarial safety evidence.
- Responsive dashboard with PnL, price, decisions, simulation feed, protocol readiness, and explorer-linked transactions.
- Deploy-safe verified snapshots for fast public rendering, with live RPC replay available as an opt-in mode.

## Verification

| Check | Result |
|---|---|
| Foundry contracts | 26/26 passing |
| Agent tests | 135/135 passing |
| Agent TypeScript | Clean |
| Dashboard production build | Passing |
| Public Vercel smoke test | Passing |
| Public browser console | No errors |
| Mobile width at 390 px | No horizontal overflow |
| Merchant Moe happy-path fork | Passing |
| Merchant Moe adversarial fork | 5/5 passing |

## Submission Boundaries

- The hosted dashboard defaults to tracked, explorer-verifiable evidence so serverless deployment does not depend on large historical RPC scans.
- Set `CHAIN_REPLAY_SOURCE=live` and configure a historical-log-capable RPC to replay chain events directly.
- Mainnet execution is intentionally disabled; only Mantle Sepolia writes and disposable fork-local mainnet transactions are permitted.
- The current benchmark is a short hackathon evidence window, not a claim of long-term investment performance.
- Recharts 2 reports an upstream deprecation warning during build, but the production build and rendered charts pass.

## Recommended Demo Flow

1. Open the live dashboard and establish the Human-vs-AI comparison.
2. Show the AI's +25 bps result, lower drawdown, and two correctly blocked trades.
3. Open an explorer-linked Mantle Sepolia decision transaction to prove the replay is chain-backed.
4. Show the Merchant Moe fork gate and `5/5` adversarial safety suite.
5. Close with the architecture: the model proposes intent, deterministic adapters build calldata, risk and simulation gates validate it, and the vault enforces the final boundary.
