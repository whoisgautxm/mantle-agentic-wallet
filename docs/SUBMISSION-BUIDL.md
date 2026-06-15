# DoraHacks BUIDL — Autonomous Agent Wallet on Mantle

*Paste-ready submission copy for the Mantle "Turing Test" Hackathon 2026 — Agentic Wallets & Economy track. Fill the demo-video URL where noted.*

---

## Name
Autonomous Agent Wallet on Mantle — an AI trader that's bounded by the chain

## One-line tagline
An AI agent that custodies funds in a smart-contract wallet on Mantle and trades autonomously under hard, on-chain safety limits — benchmarked head-to-head against a deterministic human (DCA) baseline, with every decision replayable from chain events.

## Elevator pitch (summary field)
Most "agentic DeFi" demos stop at "the model made a trade." That's not enough for real wallets. We built a guarded AI wallet where the model only proposes high-level intent, TypeScript encodes the calldata, a risk engine preflights it, and the Solidity vault is the source of truth: every trade is bounded on-chain by per-tx and daily limits, a target allowlist, a forced minimum-output check, and an oracle-bound price floor — so a fully compromised agent key still cannot drain the vault. We run the AI 24/7 against a deterministic DCA "human" baseline on Mantle Sepolia, and on a 100-path, multi-seed held-out benchmark (net of fees, slippage, and gas) the AI beats DCA decisively (~93% of paths) and beats a momentum baseline on average return. Live on AWS, fully open-source, CI-green.

---

## The problem
The hard problem isn't getting an LLM to say buy or sell. It's converting model intent into **bounded, simulated, protocol-aware execution without giving the model arbitrary control over user funds** — handling stale oracles, manipulated quotes, slippage, approvals, failed simulations, daily limits, and human auditability.

## What we built
- **`AgentVault` (Solidity):** holds funds; only a scoped agent key can `executeGuarded` calls to owner-allowlisted venues, under per-tx + rolling-24h daily limits, a pause kill-switch, and agent-key rotation. Guarded trades enforce a **minimum output (balance-delta)** and an **oracle-bound floor** on-chain, so even a compromised agent can't settle a swap far below fair value. Every action emits `AgentDecision(nonce, target, value, data, rationale)`.
- **AI agent (TypeScript):** observes a block-pinned snapshot → asks an LLM (OpenAI/Anthropic) for a regime-aware `buy/sell/hold` intent → encodes calldata in code → preflights via a risk engine (oracle freshness/deviation, position/trade-value caps, simulation, allowlist) and an optional dynamic gas-cost gate → submits through the vault.
- **Deterministic DCA "human" baseline:** a second vault running a fixed-size buy each tick — the comparison anchor.
- **Self-contained `MockDEX` + `MockOracle`:** an internal-ledger swap venue with an owner/keeper-set price, so the demo is reliable and reproducible (a seeded/scripted keeper replays identical market paths). Real-protocol readiness is proven separately on Merchant Moe mainnet **forks**.
- **Next.js dashboard:** reconstructs price, PnL (vault-only **and** gas-adjusted), trades, and the full decision replay from on-chain events — with a provenance banner so a snapshot is never mislabeled as a live run.

## Results (honest)
On 100 deterministic, no-lookahead held-out market paths per seed, net of 30 bps fee + 20 bps slippage + gas:

| Seed | AI | DCA | Momentum |
|---|---:|---:|---:|
| 20260607 | +63 bps | -48 | +17 |
| 20260608 | +57 bps | -72 | +23 |
| 99999999 | +66 bps | -50 | +25 |

- **vs the DCA human baseline: decisive** — the AI wins ~92–94 of 100 paths every seed.
- **vs momentum:** the AI wins on **average return** on all three seeds, though per-path it's ~even (its edge is bigger, better-timed wins). We do not claim it beats momentum on most paths.
- **Gas matters:** at small order sizes, DCA's gas can exceed its trading gain (a +6 bps vault gain became ≈ −452 bps after real gas in one live run). Our accounting shows both vault-only and gas-adjusted ROI so this can't be hidden.

## Why it fits the Turing Test theme
Every agent decision — including its natural-language rationale — is recorded on-chain and replayable, making the agent's behavior an auditable benchmark. The AI runs head-to-head against a deterministic human strategy, bounded by contracts, simulated before execution, and validated against real protocol data.

## Safety model (what's enforced where)
| Protection | Enforcement |
|---|---|
| Agent-only execution, pause, agent rotation, owner withdraw | On-chain |
| Target allowlist + guard-required venues | On-chain |
| Per-tx + rolling daily limits | On-chain |
| Minimum-output (balance delta) + oracle-bound floor | On-chain |
| Reentrancy lock | On-chain |
| Oracle freshness/deviation, position/trade caps, simulation, calldata selector, allowance | Off-chain preflight |

A red-team Forge test proves a compromised agent attempting a bad-price or legacy-path bypass is reverted on-chain with funds preserved. Live mainnet execution is deliberately disabled; the production-shaped path is proven on disposable forks.

## Live links
- **Live dashboard (AWS, full 24/7 loop):** http://mantle-agent-wallet-prod-118676876.ap-south-1.elb.amazonaws.com
- **GitHub:** https://github.com/whoisgautxm/mantle-agentic-wallet
- **AI vault:** https://explorer.sepolia.mantle.xyz/address/0x31227Df6b26Ed12D966Fe28667c6c6760DAa3EFa
- **Baseline vault:** https://explorer.sepolia.mantle.xyz/address/0x345880aDca2F395b208DE6b33aE0c783D418FcD5
- **MockDEX / MockToken / MockOracle:** `0x1ff284…25A4B` / `0x5fB4D8…17D35` / `0x0ECbE1…7bEb2`
- **Guarded execution tx:** https://explorer.sepolia.mantle.xyz/tx/0xed0d6f4aac15a16c7dfac69be1eb23e873721117308c7fcefafce25e352a8174
- **Demo video:** `<ADD YOUR 2–3 MIN VIDEO LINK>`
- **Reports:** security review, held-out AI-vs-DCA benchmark, and submission-readiness (in `docs/reports/`); threat model in `SECURITY.md`.

## Tech stack
Solidity ^0.8.24 + Foundry · TypeScript + viem + OpenAI/Anthropic SDKs · Next.js · AWS ECS/Fargate (4 services behind an ALB) · GitHub Actions CI. Mantle Sepolia (chainId 5003).

## How to verify (judges)
```bash
cd contracts && forge test          # 40 on-chain guard/limit/reentrancy/oracle tests
cd ../agent && npm test             # 183 agent tests (policy, risk, eval, strategy)
cd ../agent && npm run eval:multi-regime:offline -- evals/generated/market-paths-held-out.json out.json --summary
```
CI runs contracts + agent + web on every push (badge in README).

## What's novel
- The model never writes calldata or holds arbitrary authority — intent in, code-encoded execution out, contract-enforced bounds.
- On-chain **oracle-bound minimum-output** floor: a compromised key can't settle below fair value.
- Honest, reproducible, multi-seed, gas-adjusted Human-vs-AI benchmark — including where the AI does *not* win.
- The chain itself is the benchmark: every decision + rationale is replayable from events.
