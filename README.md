# Autonomous Agent Wallet on Mantle

> An AI-controlled smart-contract wallet that trades on-chain under hard safety limits, compares itself against a deterministic human baseline, and records every decision permanently on Mantle.

**Submission for:** [The Turing Test Hackathon 2026](https://dorahacks.io/hackathon/mantleturingtesthackathon2026) - Agentic Wallets & Economy track  
**Network:** Mantle Sepolia (`chainId` `5003`)  
**Stack:** Solidity + Foundry, TypeScript + viem, OpenAI or Anthropic provider, Next.js

![Contracts](https://img.shields.io/badge/forge%20tests-26%2F26-brightgreen)
![Agent](https://img.shields.io/badge/agent%20tests-68%2F68-brightgreen)
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
| Agent | `cd agent && npm test` | 68 passing |
| Agent typecheck | `cd agent && npx tsc --noEmit` | clean |
| Dashboard build | `cd web && npm run build` | clean |

### Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
MANTLE_RPC_URL=https://rpc.sepolia.mantle.xyz
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
RISK_MAX_DEX_ORACLE_DEVIATION_BPS=300
RISK_MAX_POSITION_BPS=7000
RISK_MAX_TRADE_VALUE_BPS=2500
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
MERCHANT_MOE_ROUTE=
MERCHANT_MOE_AMOUNT_IN_WEI=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Use testnet keys only. `.env` is gitignored.

`ORACLE_PROVIDER=mockdex` keeps the current Sepolia demo deterministic. `ORACLE_PROVIDER=pyth` switches the agent and dashboard to a read-only Pyth Hermes MNT/USD reference with MockDEX fallback if Hermes is unavailable. The Pyth MNT/USD feed is inverted into a MNT-per-USD-style reference so it can be compared against the current MockDEX demo price.

Merchant Moe settings are read-only Mantle mainnet quote settings. They are used for adapter research and route/allowance readiness, not live execution from the Sepolia demo vaults.

To smoke-test a real Merchant Moe quote without execution:

```bash
cd agent
set -a && source ../.env && set +a
npm run quote:merchant-moe
```

The quote smoke requires `MERCHANT_MOE_ROUTE` as comma-separated token addresses and `MERCHANT_MOE_AMOUNT_IN_WEI` as a raw integer amount. The command only calls Merchant Moe's LBQuoter and never builds or submits swap calldata.

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
- Pyth oracle active/standby/fallback state
- execution simulation gate status
- ERC20 portfolio and allowance watch configuration

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
