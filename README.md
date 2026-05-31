# Autonomous Agent Wallet on Mantle

> An AI-controlled smart-contract wallet that trades on-chain under hard safety limits, compares itself against a deterministic human baseline, and records every decision permanently on Mantle.

**Submission for:** [The Turing Test Hackathon 2026](https://dorahacks.io/hackathon/mantleturingtesthackathon2026) - Agentic Wallets & Economy track  
**Network:** Mantle Sepolia (`chainId` `5003`)  
**Stack:** Solidity + Foundry, TypeScript + viem, Claude via Anthropic SDK, Next.js

![Contracts](https://img.shields.io/badge/forge%20tests-26%2F26-brightgreen)
![Agent](https://img.shields.io/badge/agent%20tests-16%2F16-brightgreen)
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

## The Idea

The hackathon asks whether AI agents can act autonomously on-chain and whether their behavior can be benchmarked. This project answers with a guarded wallet system:

- An AI agent controls an `AgentVault` and proposes `buy`, `sell`, or `hold`.
- A deterministic DCA runner controls a second `AgentVault` as the "human baseline."
- Both vaults trade against the same self-contained `MockDEX`.
- Every vault action emits `AgentDecision`, and every market/trade event emits from `MockDEX`.
- The dashboard reconstructs the Human-vs-AI comparison from chain logs, not a trusted off-chain database.

The key design choice: the model proposes high-level intent only. TypeScript encodes calldata, the client policy preflights the move, and the Solidity vault remains the source of truth.

---

## Architecture

```text
                    AI TRADER                            HUMAN BASELINE
              agent/src/agent.ts                        agent/src/baseline.ts
          Claude -> buy/sell/hold intent              deterministic DCA buy
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
3. **AI decides** - Claude must call `propose_action` with `buy`, `sell`, or `hold`.
4. **Code encodes** - `agent/src/dex.ts` builds `buy()` or `sell(uint256)` calldata; the LLM never writes raw calldata.
5. **Policy guards** - client-side checks mirror per-tx, daily-window, pause, balance, allowlist, and sell-token limits.
6. **Vault executes** - `AgentVault.execute(...)` enforces hard on-chain limits and emits `AgentDecision`.
7. **Dashboard replays** - Next.js reads `AgentDecision`, `PriceSet`, `Bought`, and `Sold` logs.

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
| Receipt status check | `waitForTransactionReceipt` | Reverted txs are not reported as successful |

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
│       ├── agent.ts              # Claude-driven AI trader
│       ├── baseline.ts           # deterministic DCA baseline
│       ├── keeper.ts             # owner-key price simulator
│       ├── brain.ts              # tool-use parser and Claude call
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
- Anthropic API key
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
| Agent | `cd agent && npm test` | 16 passing |
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
ANTHROPIC_API_KEY=sk-ant-...
AGENT_INTERVAL_MS=120000
BASELINE_INTERVAL_MS=60000
KEEPER_INTERVAL_MS=45000
```

Use testnet keys only. `.env` is gitignored.

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

---

## Why It Can Win

- **Directly matches the track** - autonomous AI behavior, on-chain decisions, and Human-vs-AI comparison.
- **Demo is observable** - judges can watch decisions, trades, and price/PnL move live.
- **Safety is contract-enforced** - model mistakes cannot bypass allowlist, limits, pause, or owner recovery.
- **No raw LLM calldata** - the agent chooses intent; code builds calldata.
- **Composable path forward** - replace `MockDEX` with a real Mantle DEX by changing the target and calldata encoder while keeping the vault and dashboard model.

---

## Roadmap

- Real Mantle DEX integration with slippage bounds
- Drawdown circuit breaker and Telegram alerts
- Multi-agent leaderboard from event logs
- ERC-4337/session-key account abstraction
- Mainnet hardening with multisig, timelock, monitoring, and audit

---

## License

MIT - see [LICENSE](LICENSE).

