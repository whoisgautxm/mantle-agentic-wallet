# Autonomous Agent Wallet on Mantle

> An AI-controlled smart-contract wallet that trades on-chain under hard safety limits, compares itself against a deterministic human baseline, and records every decision permanently on Mantle.

**Submission for:** [The Turing Test Hackathon 2026](https://dorahacks.io/hackathon/mantleturingtesthackathon2026) - Agentic Wallets & Economy track  
**Network:** Mantle Sepolia (`chainId` `5003`)  
**Stack:** Solidity + Foundry, TypeScript + viem, OpenAI or Anthropic provider, Next.js

![Contracts](https://img.shields.io/badge/forge%20tests-26%2F26-brightgreen)
![Agent](https://img.shields.io/badge/agent%20tests-100%2F100-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Live Links

Fill these in after deployment:

| Link | URL |
|---|---|
| Live dashboard | `https://<your-vercel-app>.vercel.app` |
| MockDEX on explorer | `https://explorer.sepolia.mantle.xyz/address/<mock-dex>` |
| AI vault on explorer | `https://explorer.sepolia.mantle.xyz/address/<ai-vault>` |
| Baseline vault on explorer | `https://explorer.sepolia.mantle.xyz/address/<baseline-vault>` |
| Demo decision tx | `https://explorer.sepolia.mantle.xyz/tx/<tx-hash>` |
| GitHub | https://github.com/whoisgautxm/mantle-agentic-wallet |

---

## The Problem

AI agents are beginning to make on-chain decisions, but most agentic DeFi demos stop at "the model made a trade." That is not enough for real wallets. A useful autonomous DeFi agent must handle stale oracle data, manipulated DEX quotes, ERC20 approvals, slippage, failed simulations, protocol allowlists, daily limits, liquidation risk, and human auditability.

The hard problem is not getting an LLM to say `buy` or `sell`. The hard problem is proving that a model's intent can be converted into bounded, simulated, protocol-aware execution without giving the model arbitrary control over user funds.

## The Idea

The hackathon asks whether AI agents can act autonomously on-chain and whether their behavior can be benchmarked. This project answers with a guarded DeFi wallet system:

- An AI agent controls an `AgentVault` and proposes `buy`, `sell`, or `hold`.
- A deterministic DCA runner controls a second `AgentVault` as the "human baseline."
- Both vaults trade against the same self-contained `MockDEX`.
- Every vault action emits `AgentDecision`, and every market/trade event emits from `MockDEX`.
- The dashboard reconstructs the Human-vs-AI comparison from chain logs, not a trusted off-chain database.

The key design choice: the model proposes high-level intent only. Protocol adapters encode calldata, the risk engine validates oracle/portfolio/simulation state, and the Solidity vault remains the source of truth.

The long-term direction is a Turing Test for DeFi agents: can an AI wallet outperform or out-risk-manage a deterministic human baseline while every action is bounded by contracts, simulated before execution, validated by real protocol data, and replayable from on-chain events?

---

## Architecture

```text
                    AI TRADER                            HUMAN BASELINE
              agent/src/agent.ts                        agent/src/baseline.ts
          OpenAI/Claude -> buy/sell/hold              deterministic DCA buy
                    |                                         |
                    v                                         v
             AgentVault (AI)                         AgentVault (Baseline)
          onlyAgent + limits + pause              onlyAgent + limits + pause
                    \                                         /
                     \                                       /
                      v                                     v
                    MockDEX - internal token ledger + owner-set price
                    emits PriceSet, Bought, Sold
                                     |
                                     v
                     Next.js dashboard reconstructs price, PnL,
                     trades, and decision replay from on-chain logs
```

### Runtime Flow

1. **Keeper simulates a market** - `npm run keeper` calls owner-only `MockDEX.setPrice`.
2. **AI observes** - reads vault MNT balance, token balance, price, limits, pause state, and price history.
3. **AI decides** - the configured provider must call `propose_action` with `buy`, `sell`, or `hold`.
4. **Code encodes** - `agent/src/dex.ts` builds `buy()` or `sell(uint256)` calldata; the LLM never writes raw calldata.
5. **Policy guards** - client-side checks mirror per-tx, daily-window, pause, balance, allowlist, and sell-token limits.
6. **Simulation preflights** - viem simulates `AgentVault.execute(...)` and blocks failed calls before `writeContract`.
7. **Vault executes** - `AgentVault.execute(...)` enforces hard on-chain limits and emits `AgentDecision`.
8. **Dashboard replays** - Next.js reads `AgentDecision`, `PriceSet`, `Bought`, and `Sold` logs.

---

## Safety Model

| Guardrail | Enforced by | Effect |
|---|---|---|
| Agent-only execution | `onlyAgent` | Human owner delegates execution to scoped agent keys |
| Target allowlist | `allowedTarget[target]` | Agent can only call approved venues |
| Per-transaction limit | `value <= spendLimitPerTx` | Caps each buy/action |
| Rolling 24h daily limit | `spentToday + value <= dailyLimit` | Caps outflow and resets after 24h |
| Pause switch | `setPaused(true)` | Owner can immediately stop execution |
| Agent rotation | `setAgent(newAgent)` | Owner can rotate compromised session keys |
| Owner withdrawal | `withdraw(amount)` | Human owner can recover funds |
| Calldata generation in code | `dex.ts` | Prevents LLM malformed-calldata or arbitrary-call footguns |
| Execution simulation | `agent/src/simulation` | Blocks calls that would revert before spending gas |
| Receipt status check | `waitForTransactionReceipt` | Reverted txs are not reported as successful |
| Drawdown soft breaker | `agent/src/agent.ts` | AI stops trading if portfolio value drops 15% from observed peak |
| Optional Telegram alerts | `agent/src/telegram.ts` | Sends hold/trade notifications when env vars are configured |

`AgentVault` is the source of truth. The TypeScript policy is just a preflight to avoid doomed transactions.

---

## On-Chain Benchmark Events

`AgentVault` records reasoning:

```solidity
event AgentDecision(
    uint256 indexed nonce,
    address indexed target,
    uint256 value,
    bytes data,
    string rationale
);
```

`MockDEX` records the market and trades:

```solidity
event PriceSet(uint256 price);
event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price);
event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price);
```

Together, these events form a replayable benchmark: what the agent saw, what it did, why it did it, and how it compared against a baseline strategy.

---

## Repository Structure

```text
.
├── contracts/
│   ├── src/AgentVault.sol        # guarded agent wallet
│   ├── src/MockDEX.sol           # internal-ledger trading venue
│   ├── src/PaymentSink.sol       # legacy simple-payment demo target
│   ├── test/AgentVault.t.sol
│   ├── test/MockDEX.t.sol
│   └── script/Deploy.s.sol       # deploys MockDEX + AI/baseline vaults
├── agent/
│   └── src/
│       ├── agent.ts              # provider-driven AI trader
│       ├── baseline.ts           # deterministic DCA baseline
│       ├── keeper.ts             # owner-key price simulator
│       ├── brain.ts              # tool-use parser and provider calls
│       ├── dex.ts                # DEX ABI and calldata encoders
│       ├── chain.ts              # viem reads/writes
│       └── policy.ts             # client-side preflight guard
├── web/
│   ├── app/page.tsx              # Human-vs-AI dashboard
│   ├── app/components/           # chart + decision feeds
│   └── lib/                      # event reads + PnL reconstruction
└── shared/addresses.json         # deployed addresses and deploy block
```

---

## Running Locally

### Prerequisites

- Foundry (`forge`)
- Node.js 22+
- OpenAI API key, or an Anthropic API key if `AI_PROVIDER=anthropic`
- Funded Mantle Sepolia keys for deployer/owner, AI agent, and baseline agent

### Test Everything

```bash
cd contracts && forge test
cd ../agent && npm test && npx tsc --noEmit
cd ../web && npm run build
```

Expected current results:

| Suite | Command | Expected |
|---|---|---|
| Contracts | `cd contracts && forge test` | 26 passing |
| Agent | `cd agent && npm test` | 112 passing |
| Agent typecheck | `cd agent && npx tsc --noEmit` | clean |
| Dashboard build | `cd web && npm run build` | clean |

### Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
MANTLE_RPC_URL=https://rpc.sepolia.mantle.xyz
LOGS_RPC_URL=https://rpc.sepolia.mantle.xyz
LOG_CHUNK_SIZE=50000
DEPLOYER_PRIVATE_KEY=0x...
AGENT_PRIVATE_KEY=0x...
BASELINE_PRIVATE_KEY=0x...
OWNER_PRIVATE_KEY=0x...
AI_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.2
# Optional if AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
AGENT_INTERVAL_MS=120000
BASELINE_INTERVAL_MS=60000
KEEPER_INTERVAL_MS=45000
DEMO_DASHBOARD_PORT=3000
DEMO_RUN_SCENARIO_EVAL=true
DEMO_RUN_TRACE_EVAL_ON_STOP=true
RISK_MAX_DEX_ORACLE_DEVIATION_BPS=300
RISK_MAX_POSITION_BPS=7000
RISK_MAX_TRADE_VALUE_BPS=2500
TRACE_ENABLED=true
TRACE_DIR=traces
TRACE_JSONL_PATH=
TRACE_EVAL_INPUT=
TRACE_EVAL_OUTPUT=
SCENARIO_EVAL_DIR=
SCENARIO_EVAL_OUTPUT=
ORACLE_PROVIDER=mockdex
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=
PYTH_MNT_USD_PRICE_ID=0x4e3037c822d852d79af3ac80e35eb420ee3b870dca49f9344a38ef4773fb0585
PYTH_MAX_AGE_SECONDS=120
PORTFOLIO_TOKENS=
PORTFOLIO_SPENDERS=MerchantMoeLBRouter:0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a:known
MERCHANT_MOE_CHAIN_ID=5000
MERCHANT_MOE_RPC_URL=
MERCHANT_MOE_LB_QUOTER=0x501b8AFd35df20f531fF45F6f695793AC3316c85
MERCHANT_MOE_LB_ROUTER=0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a
MERCHANT_MOE_ROUTE_PRESET=wmnt-usdc-direct
MERCHANT_MOE_ROUTE=
MERCHANT_MOE_AMOUNT_IN_WEI=
MERCHANT_MOE_SLIPPAGE_BPS=100
MERCHANT_MOE_DEADLINE_SECONDS=1200
MERCHANT_MOE_FORK_RPC_URL=
MANTLE_MAINNET_FORK_RPC_URL=
MERCHANT_MOE_ENABLE_FORK_SIMULATION=false
MERCHANT_MOE_SIMULATION_MODE=router-call
MERCHANT_MOE_SIMULATION_FROM=
MERCHANT_MOE_SIMULATION_VAULT=
MERCHANT_MOE_SIMULATION_VALUE_WEI=0
MERCHANT_MOE_SWAP_CALLDATA=
MERCHANT_MOE_SIMULATION_RATIONALE=Merchant Moe mainnet-fork simulation
MERCHANT_MOE_TOKEN_IN_DECIMALS=
MERCHANT_MOE_TOKEN_OUT_DECIMALS=
MERCHANT_MOE_REFERENCE_SOURCE=
MERCHANT_MOE_REFERENCE_PRICE_WEI=
MERCHANT_MOE_MAX_DEVIATION_BPS=
LENDING_PROTOCOL_ID=lendle
LENDING_ACCOUNT=
LENDING_POSITION_JSON=
LENDING_MARKETS_JSON=
LENDING_MIN_HEALTH_FACTOR_BPS=15000
LENDING_WARN_HEALTH_FACTOR_BPS=18000
LENDING_MAX_MARKET_UTILIZATION_BPS=9000
LENDING_MAX_CAP_USAGE_BPS=9500
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Use testnet keys only. `.env` is gitignored.

`ORACLE_PROVIDER=mockdex` keeps the current Sepolia demo deterministic. `ORACLE_PROVIDER=pyth` switches the agent and dashboard to a read-only Pyth Hermes MNT/USD reference with MockDEX fallback if Hermes is unavailable. The Pyth MNT/USD feed is inverted into a MNT-per-USD-style reference so it can be compared against the current MockDEX demo price.

Merchant Moe settings are read-only Mantle mainnet quote settings. They are used for adapter research and route/allowance readiness, not live execution from the Sepolia demo vaults.

Verified route presets:

- `wmnt-usdc-direct` - conservative default, WMNT -> USDC, 18 -> 6 decimals, Pyth MNT/USD reference, 500 bps max deviation.
- `wmnt-moe-usdc` - optional liquidity route, WMNT -> MOE -> USDC, Pyth MNT/USD reference, 500 bps max deviation.
- `wmnt-usdt-direct` - secondary stable route, WMNT -> USDT, 18 -> 6 decimals, Pyth MNT/USD reference, 500 bps max deviation.
- `wmnt-usde-direct` - experimental stable route, WMNT -> USDe, 18 -> 18 decimals, Pyth MNT/USD reference, 750 bps max deviation.

Leave `MERCHANT_MOE_ROUTE`, amount, decimal, reference, and max-deviation fields blank to use the preset defaults. Set those fields only when intentionally overriding a preset.

To smoke-test a real Merchant Moe quote without execution:

```bash
cd agent
set -a && source ../.env && set +a
npm run quote:merchant-moe
```

The quote smoke requires either `MERCHANT_MOE_ROUTE_PRESET` or `MERCHANT_MOE_ROUTE` as comma-separated token addresses plus `MERCHANT_MOE_AMOUNT_IN_WEI` as a raw integer amount when no preset is used. Optional decimal/reference settings let it report quote-vs-reference deviation. For MNT -> USD-like routes, `MERCHANT_MOE_REFERENCE_SOURCE=pyth-mnt-usd` compares the normalized token-in/token-out quote against the inverted Pyth MNT/USD feed. The command only calls Merchant Moe's LBQuoter and never builds or submits swap calldata.

To produce a fork-readiness report with slippage/min-output metadata:

```bash
cd agent
set -a && source ../.env && set +a
npm run readiness:merchant-moe
```

The readiness report computes `minOutWei` from `MERCHANT_MOE_SLIPPAGE_BPS`, checks the quote/reference deviation, records whether a fork RPC is configured, and still blocks execution because Merchant Moe calldata generation is intentionally disabled until fork tests are added.

To produce the mainnet-fork simulation gate report:

```bash
cd agent
set -a && source ../.env && set +a
npm run simulate:merchant-moe-fork
```

The simulation command reuses the Merchant Moe quote/readiness path, then checks whether fork simulation can run. Set `MANTLE_MAINNET_FORK_RPC_URL` or `MERCHANT_MOE_FORK_RPC_URL`, `MERCHANT_MOE_ENABLE_FORK_SIMULATION=true`, `MERCHANT_MOE_SIMULATION_FROM`, and `MERCHANT_MOE_SWAP_CALLDATA` to attempt a fork-only call. `MERCHANT_MOE_SIMULATION_MODE=router-call` simulates a direct LBRouter call; `vault-execute` simulates `AgentVault.execute` on a fork where `MERCHANT_MOE_SIMULATION_VAULT` exists. The command writes `merchant_moe.fork_simulation` JSONL evidence and never submits a transaction.

Lending/yield settings are also read-only. They let the project model Lendle/INIT-style health-factor risk from a local snapshot before any supply, withdraw, borrow, or repay execution exists.

Example local health snapshot:

```bash
LENDING_POSITION_JSON='{"protocolId":"lendle","account":"0x1111111111111111111111111111111111111111","assets":[{"symbol":"USDC","suppliedValueWei":"1000000000000000000000","debtValueWei":"250000000000000000000","liquidationThresholdBps":"8000"}]}'
LENDING_MARKETS_JSON='[{"marketId":"usdc","symbol":"USDC","utilizationBps":"8500","supplyCapUsedBps":"7000"}]'
```

To produce a lending health-readiness report:

```bash
cd agent
set -a && source ../.env && set +a
npm run readiness:lending
```

The command computes supplied/debt value, weighted liquidation threshold, health factor, liquidation buffer, utilization/cap warnings, and hard health-factor blockers. It writes `lending.readiness` to the JSONL trace and never builds or submits lending calldata.

### Local JSONL Traces

Agent, baseline, Merchant Moe, and lending-readiness runs write replayable JSONL events by default to `agent/traces/agent-events.jsonl` when commands are run from `agent/`. These traces include observations, quotes, oracle snapshots, decisions, simulation results, risk results, final actions, quote-smoke risk reports, and lending health reports. They are gitignored and contain no private keys.

Set `TRACE_ENABLED=false` to disable tracing, or set `TRACE_JSONL_PATH=/path/to/file.jsonl` to choose an explicit output file.

To grade a trace locally:

```bash
cd agent
npm run eval:traces
```

The trace eval checks core policy obedience: executed ticks must have passing risk and simulation results, failed risk must block, failed simulation must not execute, and stale oracle ticks must not execute. Pass an explicit input/output path with `npm run eval:traces -- traces/agent-events.jsonl traces/trace-summary.json`.

To run deterministic risk scenarios without RPC, private keys, or model calls:

```bash
cd agent
npm run eval:scenarios
```

The default scenario pack covers safe buys, stale oracle blocks, failed simulation blocks, disallowed targets, and oversized trades. Pass a custom scenario directory/output path with `npm run eval:scenarios -- evals/scenarios traces/scenario-summary.json`.

To run a model-backed OpenAI replay judge over the real trace:

```bash
cd agent
npm run eval:openai-replay -- traces/agent-events.jsonl traces/openai-replay-eval.json
```

This command loads the repo root `.env` and `agent/.env`, summarizes AI/baseline replay ticks plus real-protocol readiness signals, and asks an OpenAI model for a structured report covering safety, decision quality, evidence quality, and AI-vs-baseline performance. Set `OPENAI_EVAL_MODEL` to override the judge model; otherwise it uses `OPENAI_MODEL`.

The dashboard reads these summary artifacts when present:

```bash
cd agent
npm run eval:traces -- traces/agent-events.jsonl traces/trace-summary.json
npm run eval:scenarios -- evals/scenarios traces/scenario-summary.json
npm run eval:openai-replay -- traces/agent-events.jsonl traces/openai-replay-eval.json
```

If `TRACE_EVAL_OUTPUT`, `SCENARIO_EVAL_OUTPUT`, or `OPENAI_REPLAY_EVAL_OUTPUT` are set, the dashboard uses those paths instead. Relative paths are resolved from `agent/`.

The dashboard also reads the latest `merchant_moe.quote_smoke`, `merchant_moe.fork_readiness`, `merchant_moe.fork_simulation`, and `lending.readiness` events from the JSONL trace. It shows route, amount, min-output, slippage, quote-risk, fork-RPC, fork simulation status, health factor, liquidation buffer, blockers, and next-step evidence in real-protocol panels. The execution preflight feed also replays proposed agent/baseline transactions and Merchant Moe fork simulations with target, selector, value, calldata bytes, simulation pass/fail, gas estimate, revert reason, tx hash, and blocked-execution reason.

Merchant Moe references:

- Merchant Moe contract addresses: https://docs.merchantmoe.com/resources/contracts
- LFJ LBQuoter docs: https://developers.lfj.gg/contracts/lbquoter
- Pyth Hermes price updates: https://docs.pyth.network/price-feeds/core/fetch-price-updates
- Pyth price feed IDs: https://docs.pyth.network/price-feeds/core/price-feeds/price-feed-ids

---

## Deploying to Mantle Sepolia

From the repo root:

```bash
set -a && source .env && set +a
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "$MANTLE_RPC_URL" --broadcast
```

The script deploys:

- `MockDEX`
- AI `AgentVault`
- baseline `AgentVault`
- allowlists `MockDEX` in both vaults
- seeds DEX liquidity and vault balances

Copy the printed values into `shared/addresses.json`:

```json
{
  "chainId": 5003,
  "agentVault": "0x...",
  "paymentSink": "0x0000000000000000000000000000000000000000",
  "mockDex": "0x...",
  "aiVault": "0x...",
  "baselineVault": "0x...",
  "deployBlock": 12345678
}
```

`agentVault` is kept for compatibility and should match `aiVault`.

---

## Running the Live Demo

### One-Command Demo

The safest demo path is the orchestrator. It starts exactly one keeper, one AI runner, one baseline runner, and one dashboard, then cleans them up on `Ctrl-C`.

```bash
cd agent
npm run demo
```

Useful variants:

```bash
npm run demo -- --port 4000
npm run demo -- --no-agent
npm run demo -- --no-baseline
npm run demo:status
npm run demo:stop
```

`npm run demo` writes PID records to `.runtime/`, generates `traces/scenario-summary.json` on start, and generates `traces/trace-summary.json` on shutdown when `traces/agent-events.jsonl` exists. Those summary files are what the dashboard's replay benchmark panel reads.

### Manual Terminals

Use separate terminals from the repo root:

```bash
cd agent && set -a && source ../.env && set +a && npm run keeper
```

```bash
cd agent && set -a && source ../.env && set +a && npm start
```

```bash
cd agent && set -a && source ../.env && set +a && npm run baseline
```

```bash
cd web && npm run dev
```

Open `http://localhost:3000`. The dashboard auto-refreshes every 15 seconds.

The dashboard now includes protocol readiness alongside the replay:

- MockDEX executable status and vault allowlist posture
- Merchant Moe read-only adapter readiness
- Merchant Moe quote/fork-readiness evidence from JSONL traces
- execution preflight feed for proposed tx, simulation pass/fail, gas, revert, and blocker reason
- Lendle/INIT-style lending health-factor evidence from JSONL traces
- Pyth oracle active/standby/fallback state
- execution simulation gate status
- ERC20 portfolio and allowance watch configuration
- eval/readiness cards for JSONL trace replay, deterministic scenario packs, and OpenAI model-backed replay judging

---

## Why It Can Win

- **Directly matches the track** - autonomous AI behavior, on-chain decisions, and Human-vs-AI comparison.
- **Demo is observable** - judges can watch decisions, trades, and price/PnL move live.
- **Safety is contract-enforced** - model mistakes cannot bypass allowlist, limits, pause, or owner recovery.
- **Safety is observable** - drawdown soft-pauses and optional Telegram alerts make the live agent easier to monitor.
- **No raw LLM calldata** - the agent chooses intent; code builds calldata.
- **Composable path forward** - replace `MockDEX` with a real Mantle DEX by changing the target and calldata encoder while keeping the vault and dashboard model.

---

## Roadmap

- Merchant Moe real quote smoke tests with Pyth deviation checks
- Mantle mainnet-fork simulation before any real DEX execution
- Read-only Lendle/INIT lending risk adapters for health factor, borrow caps, and liquidation buffer
- Structured decision traces and OpenAI eval scenarios for policy obedience
- Multi-agent leaderboard from event logs
- ERC-4337/session-key account abstraction after the protocol/risk stack is stable

For the deeper real-protocol strategy, see [docs/strategy/real-defi-problem-statement.md](docs/strategy/real-defi-problem-statement.md).

---

## License

MIT - see [LICENSE](LICENSE).
