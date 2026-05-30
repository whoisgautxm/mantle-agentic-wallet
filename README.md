# 🤖 Autonomous Agent Wallet on Mantle

> **An AI agent that holds its own funds and transacts on-chain — autonomously, under hard safety limits, with every single decision (and its reasoning) recorded permanently on Mantle.**

**Submission for:** [The Turing Test Hackathon 2026](https://dorahacks.io/hackathon/mantleturingtesthackathon2026) — **Agentic Wallets & Economy** track
**Network:** Mantle Sepolia (chainId `5003`)
**Stack:** Solidity (Foundry) · TypeScript (viem) · Claude (Anthropic SDK) · Next.js

<!-- Badges -->
![Contracts](https://img.shields.io/badge/forge%20tests-15%2F15-brightgreen)
![Agent](https://img.shields.io/badge/agent%20tests-11%2F11-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 🔗 Live Links

> _Fill these in after deployment (see [Deploying](#-deploying-to-mantle))._

| | |
|---|---|
| **Live dashboard** | `https://<your-vercel-app>.vercel.app` |
| **AgentVault on explorer** | `https://explorer.sepolia.mantle.xyz/address/<vault-address>` |
| **Demo agent decision (on-chain)** | `https://explorer.sepolia.mantle.xyz/tx/<tx-hash>` |
| **Demo video** | `https://<youtube-or-loom-link>` |
| **GitHub** | https://github.com/whoisgautxm/mantle-agentic-wallet |

---

## The Idea in One Sentence

The hackathon asks: *can an AI agent act autonomously on-chain, and can we benchmark its behavior?* Our answer is a **smart-contract wallet that an AI agent controls** — it observes, reasons with an LLM, and submits its own Mantle transactions — where the contract itself **enforces hard spending limits** and **emits an on-chain log of every decision plus the agent's natural-language rationale.** Autonomy with accountability, written to the chain.

## Why It Fits "The Turing Test" Theme

The hackathon is framed as an **on-chain benchmark for agentic AI interacting with DeFi rails** — a "Human vs AI" experiment where Mantle records agent decisions and outcomes on-chain. This project is a direct, literal implementation of that premise:

- **Every agent action is a benchmark data point.** The `AgentVault.AgentDecision` event captures the nonce, target, value, calldata, *and the agent's reasoning string* for each move — a permanent, queryable record of how the agent behaved.
- **The agent is genuinely autonomous.** No human signs the transactions. A dedicated agent key (a "session key") submits them; the human owner only sets guardrails and can pause.
- **It's safe enough to actually run.** The contract — not the model — is the source of truth for what the agent is allowed to do. An LLM hallucination cannot drain the vault.

---

## How It Works

```
                    ┌──────────────────────────────────────────────┐
                    │                  AGENT RUNTIME (TypeScript)     │
                    │                                                 │
   ┌────────────┐   │  1. observe ──► readVaultState()  (viem reads)  │
   │   Claude    │◄──┤  2. decide  ──► propose_action tool (pay/hold)  │
   │ (Sonnet 4.6)│──►│       LLM returns a HIGH-LEVEL intent only      │
   └────────────┘   │  3. encode  ──► agent builds calldata + wei      │
                    │       (encodeFunctionData / parseEther in code)  │
                    │  4. guard   ──► checkPolicy() mirrors the contract│
                    │             ──► isTargetAllowed() on-chain check  │
                    │  5. submit  ──► execute(...) via the agent key    │
                    └───────────────────────┬─────────────────────────┘
                                             │  signs & sends tx
                                             ▼
            ┌─────────────────────────────────────────────────────────┐
            │            AgentVault.sol  (Mantle — source of truth)      │
            │                                                            │
            │  execute(target, value, data, rationale) onlyAgent:        │
            │    require !paused                                         │
            │    require allowedTarget[target]                          │
            │    require value <= spendLimitPerTx                       │
            │    require spentToday + value <= dailyLimit  (rolling 24h) │
            │    emit AgentDecision(nonce, target, value, data, rationale)│ ◄── the benchmark log
            │    target.call{value}(data)                               │
            └───────────────────────┬───────────────────────────────────┘
                                     │  emits events
                                     ▼
            ┌─────────────────────────────────────────────────────────┐
            │     Next.js Dashboard  —  reads AgentDecision logs         │
            │     "Watch the agent think and act, live, on-chain."       │
            └─────────────────────────────────────────────────────────┘
```

### The flow, step by step
1. **Observe** — the agent reads live vault state from Mantle (balance, per-tx limit, daily limit, spent-today, paused).
2. **Decide** — it sends that state to Claude, which must call the `propose_action` tool, returning a **high-level intent**: `pay` (amount + memo) or `hold`, with a rationale.
3. **Encode in code, not in the model** — the agent itself computes the wei amount (`parseEther`) and ABI-encodes the calldata (`encodeFunctionData`). The LLM never produces raw calldata, so a malformed-hex hallucination is impossible.
4. **Guard** — a client-side policy check mirrors the contract's limits exactly, and an on-chain `allowedTarget` check ensures we never waste a transaction on a target the vault would reject.
5. **Submit** — the agent key sends `execute(...)`; the wallet client waits for the receipt and **throws if the transaction reverted** (so a failed action is never reported as success).

---

## The Safety Model (the differentiator)

A wallet you hand to an autonomous AI is only as trustworthy as its guardrails. Ours are enforced **on-chain**, so they hold even if the agent code or the LLM misbehaves:

| Guardrail | Enforced by | Effect |
|---|---|---|
| **Per-transaction limit** | `require(value <= spendLimitPerTx)` | The agent can never move more than X per action |
| **Rolling 24h daily limit** | `require(spentToday + value <= dailyLimit)` | Caps total daily outflow; auto-resets after 24h |
| **Target allowlist** | `require(allowedTarget[target])` | The agent can only interact with owner-approved contracts |
| **Kill switch** | `setPaused(true)` (owner-only) | Instantly halts all agent activity |
| **Agent-key rotation** | `setAgent(newKey)` (owner-only) | If the session key is compromised, rotate without redeploying |
| **Owner-only fund recovery** | `withdraw(amount)` | The human can always reclaim funds |

Defense-in-depth: the **contract is the source of truth**, the agent runs a **client-side mirror** of the same checks as a pre-flight, and **checks-effects-interactions** ordering plus the `onlyAgent` guard make reentrancy a non-issue (proven by a dedicated reentrancy test).

---

## The On-Chain Decision Log

Every action emits:

```solidity
event AgentDecision(
    uint256 indexed nonce,
    address indexed target,
    uint256 value,
    bytes   data,
    string  rationale   // the agent's own words: "why I did this"
);
```

This is the heart of the "benchmark" idea — anyone can replay the full history of the agent's behavior, reasoning included, straight from Mantle. The dashboard does exactly this, turning the chain into a live feed of the agent's mind.

---

## Tech Stack

- **Smart contracts:** Solidity `^0.8.24`, [Foundry](https://book.getfoundry.sh/) (forge / cast)
- **Agent runtime:** TypeScript, Node 22, [viem](https://viem.sh) `2.x`, [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) `0.40.1` (Claude Sonnet 4.6 for the loop), [vitest](https://vitest.dev)
- **Dashboard:** Next.js 15 (App Router), viem for log reads, deployable to Vercel
- **Chain:** Mantle Sepolia testnet (`5003`)

---

## Repository Structure

```
.
├── contracts/                 # Foundry project
│   ├── src/
│   │   ├── AgentVault.sol      # the agent-controlled vault (guards + decision log)
│   │   └── PaymentSink.sol     # demo target the agent pays
│   ├── test/AgentVault.t.sol   # 15 tests: access, limits, pause, reentrancy, rotation
│   └── script/Deploy.s.sol     # deploys vault + sink, allowlists, seeds, logs block
├── agent/                     # TypeScript agent runtime
│   └── src/
│       ├── types.ts            # Decision / VaultState types
│       ├── policy.ts           # client-side guard mirroring the contract  (TDD)
│       ├── brain.ts            # Claude tool-use → encoded Decision         (TDD)
│       ├── chain.ts            # viem reads/writes + on-chain allowlist check
│       ├── config.ts           # env + chain + address wiring
│       └── agent.ts            # the observe→decide→guard→execute loop
├── web/                       # Next.js dashboard
│   ├── lib/events.ts           # reads AgentDecision logs from deployBlock
│   └── app/page.tsx            # live decision feed
├── shared/addresses.json      # { chainId, agentVault, paymentSink, deployBlock }
└── docs/superpowers/plans/    # the full implementation plan
```

---

## Running It Locally

### Prerequisites
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`)
- Node.js 22+
- An [Anthropic API key](https://console.anthropic.com/) (for the agent)
- A funded Mantle Sepolia key (from the [Mantle faucet](https://faucet.sepolia.mantle.xyz/))

### 1. Contracts
```bash
cd contracts
forge test -vvv          # 15 tests pass
```

### 2. Agent
```bash
cd agent
npm install
npm test                 # 11 unit tests pass
npx tsc --noEmit         # typecheck
```

### 3. Dashboard
```bash
cd web
npm install
npm run dev              # http://localhost:3000
```

### 4. Configure environment
Copy `.env.example` to `.env` and fill in:
```bash
MANTLE_RPC_URL=https://rpc.sepolia.mantle.xyz
DEPLOYER_PRIVATE_KEY=0x...     # owner; fund from the faucet
AGENT_PRIVATE_KEY=0x...        # the agent's session key; fund with a little gas
ANTHROPIC_API_KEY=sk-ant-...
AGENT_INTERVAL_MS=120000
AGENT_CONTEXT=Maintain the treasury. Only act if there is a clear, low-risk reason.
```
> ⚠️ `.env` is gitignored — never commit real keys. Use **testnet** keys only.

---

## Deploying to Mantle

```bash
# from repo root, with .env filled and both keys funded
set -a && source .env && set +a
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "$MANTLE_RPC_URL" --broadcast
```

The script deploys `AgentVault` + `PaymentSink`, **allowlists the sink**, seeds the vault, and prints the deploy block. Copy the printed values into `shared/addresses.json`:

```json
{
  "chainId": 5003,
  "agentVault": "0x...",
  "paymentSink": "0x...",
  "deployBlock": 12345678
}
```

Then run the live agent:
```bash
cd agent && set -a && source ../.env && set +a && npm start
```
You'll see it observe state, get a decision from Claude, pass the guards, and submit a transaction — emitting an `AgentDecision` you can watch on the explorer and the dashboard.

---

## Testing

| Suite | Command | Coverage |
|---|---|---|
| Contracts (15) | `cd contracts && forge test` | agent-only access, per-tx/daily limits, 24h reset, pause, allowlist, decision-event emission, **reentrancy**, zero-address guard, agent rotation, limit updates, withdraw, call-failure |
| Agent (11) | `cd agent && npm test` | policy guard (incl. exact inclusive boundaries matching the contract), high-level-intent → encoded-Decision parsing |

Money-handling code (`AgentVault.sol`, `policy.ts`) was built **test-first (TDD)**, and the security model was hardened in code review (reentrancy is proven blocked, the client guard mirrors the contract's exact inequality boundaries).

---

## What Makes It Win

- **Dead-on the track theme** — an autonomous agent that *actually transacts on-chain* on Mantle, with an on-chain benchmark log built in.
- **Safety judges can trust** — limits, allowlist, pause, and key rotation enforced by the contract, not the prompt. Reentrancy-tested.
- **A demo that sells itself** — the dashboard turns the agent's reasoning into a live, shareable feed (great for community vote + UI/UX).
- **No LLM-calldata footguns** — the model proposes intent; the code does the encoding. Robust by construction.
- **Composable by design** — any allowlisted contract is a valid agent target, so the same vault drops cleanly onto real DeFi rails (or the Byreal Skills CLI) post-hackathon.

## Roadmap

- Multiple action types (swap, stake, LP) behind the same allowlist + decision-log model
- Strategy modules the agent can choose between, each scored by realized on-chain outcomes
- Multi-agent "Human vs AI" leaderboard reading directly from `AgentDecision` logs across vaults
- Mainnet deployment with conservative limits and a timelocked owner

---

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Built for the Mantle Turing Test Hackathon 2026. Contracts, agent, and dashboard are independently tested; the contract is the source of truth for all agent permissions.</sub>
