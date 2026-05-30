# Mantle Autonomous Agent Wallet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous AI agent that custodies funds in a smart-contract wallet on Mantle, decides actions via Claude, executes them on-chain under hard safety limits, and records every decision on-chain — plus a live dashboard — as a submission to the Mantle "Turing Test" Hackathon 2026 (Agentic Wallets & Economy track).

**Architecture:** Three units in one monorepo. (1) `contracts/` — a Foundry `AgentVault` Solidity contract that holds funds, restricts execution to the agent key under per-tx/daily/allowlist/pause guards, and emits an `AgentDecision` event (target, value, calldata, rationale) for every action — this on-chain decision log is the hook for the hackathon's "on-chain AI benchmark / Human vs AI" theme. (2) `agent/` — a TypeScript observe→reason→act loop using `@anthropic-ai/sdk` (tool use) to propose actions and `viem` to sign and submit Mantle transactions through the vault, with a client-side policy guard mirroring the contract. (3) `web/` — a Next.js dashboard that reads `AgentDecision` events from chain and streams the agent's live reasoning with explorer links.

**Tech Stack:** Solidity ^0.8.24 + Foundry (forge/anvil/cast) · TypeScript + Node 22 · viem (Mantle chains built in) · @anthropic-ai/sdk (Claude Sonnet 4.6 for the loop, Opus 4.8 for final demo) · vitest (agent unit tests) · Next.js App Router + Vercel (dashboard). Target chain: **Mantle Sepolia testnet** (chainId 5003) for the build, Mantle mainnet (chainId 5000) only if time permits.

---

## Scope & Self-Contained Milestones

This is one product, but each phase produces something demonstrable on its own:
- **Phase 0** → a configured Claude Code workspace + repo scaffold (you can commit and build).
- **Phase 1–2** → a deployed, tested `AgentVault` on Mantle Sepolia (you can show it on the explorer).
- **Phase 3–4** → an agent that autonomously executes a real on-chain action under limits (the core demo).
- **Phase 5** → a live dashboard of agent decisions (the community-vote / UI-UX asset).
- **Phase 6** → submission package (video, README, DoraHacks BUIDL).

**Hard rule for money-handling code (Phase 1 & 4): TDD is non-negotiable.** Write the failing test, watch it fail, implement minimally, watch it pass, commit. The dashboard (Phase 5) is verified manually — UI assertions aren't worth the time here.

**Two facts to verify before you depend on them** (early steps below do this explicitly, don't skip):
1. **Mantle network params** (RPC URL, chainId, explorer, faucet) — confirm at `https://docs.mantle.xyz` before deploying. The values in this plan are the expected ones but networks change.
2. **Byreal Skills CLI** — the track blurb mentions it. It is treated here as an *optional integration layer*, not the critical path. Phase 3 has a timeboxed spike to evaluate it; the core agent runs on plain viem + Anthropic SDK regardless, so you are never blocked.

---

## File Structure

```
Turing-Hackathon/
├─ CLAUDE.md                      # project rules for Claude Code (stack, conventions, guardrails)
├─ .codex/config.toml             # Codex plugin defaults for this repo
├─ .gitignore
├─ .env.example                   # documents required env vars (never commit real .env)
├─ contracts/                     # Foundry project
│  ├─ foundry.toml
│  ├─ src/AgentVault.sol          # the agent-controlled vault
│  ├─ test/AgentVault.t.sol       # forge tests (TDD)
│  ├─ script/Deploy.s.sol         # deploy script
│  └─ test/mocks/MockTarget.sol   # call target used in execute() tests
├─ agent/                         # TypeScript agent runtime
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ vitest.config.ts
│  ├─ src/config.ts               # env + chain + address loading
│  ├─ src/policy.ts               # client-side guard mirroring the contract (TDD)
│  ├─ src/policy.test.ts
│  ├─ src/brain.ts                # Claude tool-use: propose_action -> Decision
│  ├─ src/brain.test.ts           # tests the decision PARSING (mocked SDK)
│  ├─ src/chain.ts                # viem clients + read/write vault
│  ├─ src/agent.ts                # observe -> decide -> guard -> execute -> log loop
│  └─ src/types.ts                # shared Decision / VaultState types
├─ web/                           # Next.js dashboard
│  ├─ package.json
│  ├─ app/page.tsx                # decision feed
│  └─ lib/events.ts               # viem getLogs for AgentDecision
└─ shared/
   └─ addresses.json              # { chainId, agentVault } written by Deploy step, read by agent + web
```

Files that change together live together: each unit (`contracts`, `agent`, `web`) is independently buildable and testable. `shared/addresses.json` is the only cross-unit contract — a deployed address + chainId.

---

## Phase 0 — Claude Code "Hackathon-Winning" Setup

**Goal of this phase:** a lean, fast Claude Code workspace tuned for Solidity + TS agent work, plus the repo scaffold. We do NOT install all of ECC (249 skills = token bloat mid-hackathon). The codex plugin is already installed and authenticated. We add: a project `CLAUDE.md`, a Codex review config, git, and the monorepo skeleton.

### Task 0.1: Initialize git + monorepo skeleton

**Files:**
- Create: `/Users/gautam/Desktop/Turing-Hackathon/.gitignore`
- Create: `/Users/gautam/Desktop/Turing-Hackathon/shared/addresses.json`

- [ ] **Step 1: Init git and create directories**

Run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git init
mkdir -p contracts/src contracts/test/mocks contracts/script agent/src web/app web/lib shared
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
# secrets
.env
.env.local
*.key
# node
node_modules/
.next/
dist/
# foundry
contracts/out/
contracts/cache/
contracts/broadcast/
# misc
.DS_Store
```

- [ ] **Step 3: Write `shared/addresses.json` (placeholder until deploy)**

```json
{
  "chainId": 5003,
  "agentVault": "0x0000000000000000000000000000000000000000",
  "paymentSink": "0x0000000000000000000000000000000000000000",
  "deployBlock": 0
}
```

`paymentSink` (the agent's allowlisted action target) and `deployBlock` are filled in at deploy time (Task 2.2 / 4.2). `deployBlock` lets the dashboard's `getLogs` query start from the vault's creation block instead of scanning from genesis.

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add .gitignore shared/addresses.json
git commit -m "chore: init monorepo skeleton"
```

### Task 0.2: Write the project `CLAUDE.md` (Claude Code rules)

**Files:**
- Create: `/Users/gautam/Desktop/Turing-Hackathon/CLAUDE.md`

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
# Mantle Autonomous Agent Wallet

Hackathon submission for the Mantle "Turing Test" 2026 — Agentic Wallets & Economy track.
An AI agent that custodies funds in a smart-contract wallet on Mantle and transacts autonomously
under hard on-chain safety limits, logging every decision on-chain.

## Stack
- contracts/ — Solidity ^0.8.24, Foundry (forge test, forge script). Target: Mantle Sepolia (chainId 5003).
- agent/ — TypeScript, Node 22, viem, @anthropic-ai/sdk, vitest.
- web/ — Next.js App Router dashboard, viem for reads.

## Non-negotiable rules
- Money-handling code (AgentVault.sol, agent/src/policy.ts) is TDD: failing test first, then code.
- NEVER hardcode private keys or API keys. Read from env. .env is gitignored.
- The agent must NEVER be able to move funds outside the contract's per-tx limit, daily limit,
  target allowlist, and pause switch. The client-side policy guard mirrors the contract but the
  contract is the source of truth.
- Every agent action emits AgentVault.AgentDecision(nonce, target, value, data, rationale).
- Prefer small, focused files. Match existing style. Commit after each green test.

## Commands
- Contracts: `cd contracts && forge test -vvv`
- Agent: `cd agent && npm test`
- Dashboard: `cd web && npm run dev`

## Codex
- Use `/codex:review` before committing contract changes.
- Use `/codex:adversarial-review --base main` before submission to pressure-test the security model.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add CLAUDE.md
git commit -m "docs: add project CLAUDE.md with stack and guardrails"
```

### Task 0.3: Configure the Codex plugin for this repo

**Files:**
- Create: `/Users/gautam/Desktop/Turing-Hackathon/.codex/config.toml`

- [ ] **Step 1: Write `.codex/config.toml`** (sets Codex defaults for reviews in this repo)

```toml
# Codex plugin defaults for this project.
# Higher reasoning effort for security-sensitive contract reviews.
model = "gpt-5.4-codex"
model_reasoning_effort = "high"
```

- [ ] **Step 2: Verify Codex is ready** (already installed + logged in, this just confirms)

Run:
```bash
node "/Users/gautam/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" setup --json
```
Expected: JSON with `"ready": true` and `"loggedIn": true`.

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add .codex/config.toml
git commit -m "chore: add codex plugin config for this repo"
```

### Task 0.4: Document required environment variables

**Files:**
- Create: `/Users/gautam/Desktop/Turing-Hackathon/.env.example`

- [ ] **Step 1: Write `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored — never commit it.

# Mantle Sepolia testnet RPC (verify current URL at https://docs.mantle.xyz)
MANTLE_RPC_URL=https://rpc.sepolia.mantle.xyz

# Deployer / owner key (testnet only — fund from the Mantle faucet)
DEPLOYER_PRIVATE_KEY=0x...

# The AI agent's own key (a separate "session key" address; fund with a little gas)
AGENT_PRIVATE_KEY=0x...

# Anthropic API key for the agent's reasoning
ANTHROPIC_API_KEY=sk-ant-...

# Agent loop tuning (read by agent/src/agent.ts; see Task 4.2).
# AGENT_INTERVAL_MS: ms between ticks. AGENT_CONTEXT: the situation prompt that drives decisions.
AGENT_INTERVAL_MS=120000
AGENT_CONTEXT=Maintain the treasury. Only act if there is a clear, low-risk reason.

# Block explorer API (optional, only needed if you add `forge verify-contract`)
MANTLE_EXPLORER_API_URL=https://explorer.sepolia.mantle.xyz/api
```

- [ ] **Step 2: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add .env.example
git commit -m "docs: document required env vars"
```

### Task 0.5: Verify Mantle network params (do NOT skip)

- [ ] **Step 1: Confirm the live network values**

Open `https://docs.mantle.xyz` (Network Information / "Connecting to Mantle"). Confirm and, if different, update `.env.example` and `shared/addresses.json`:
- Mantle Sepolia testnet **chainId** (expected `5003`)
- **RPC URL** (expected `https://rpc.sepolia.mantle.xyz`)
- **Explorer** URL (expected `https://explorer.sepolia.mantle.xyz`)
- **Faucet** location (to fund your deployer + agent keys with test MNT)

- [ ] **Step 2: Fund both keys**

Use the faucet to send test MNT to the addresses derived from `DEPLOYER_PRIVATE_KEY` and `AGENT_PRIVATE_KEY`. The agent key only needs a little (it pays gas for `execute`); the deployer needs enough to deploy + fund the vault.

---

## Phase 1 — `AgentVault` Smart Contract (TDD with Foundry)

**Goal:** a vault that holds funds, lets only the agent key execute calls to allowlisted targets under a per-tx limit, a rolling 24h daily limit, and an owner pause switch; emits `AgentDecision` for every action. The contract is the source of truth for safety.

### Task 1.1: Scaffold the Foundry project

**Files:**
- Create: `contracts/foundry.toml`

- [ ] **Step 1: Init Foundry in `contracts/`**

Run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon/contracts
forge init --no-git --force .
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
```

- [ ] **Step 2: Write `contracts/foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
mantle_sepolia = "${MANTLE_RPC_URL}"
```

- [ ] **Step 3: Verify the toolchain builds**

Run: `forge build`
Expected: `Compiler run successful` (no contracts yet beyond defaults is fine).

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/foundry.toml contracts/.gitignore contracts/lib
git commit -m "chore(contracts): scaffold foundry project"
```

### Task 1.2: Mock target + first failing test (only agent can execute)

**Files:**
- Create: `contracts/test/mocks/MockTarget.sol`
- Create: `contracts/test/AgentVault.t.sol`

- [ ] **Step 1: Write the mock call target**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockTarget {
    uint256 public lastValue;
    bytes public lastData;
    bool public shouldRevert;

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function ping(uint256 x) external payable returns (uint256) {
        require(!shouldRevert, "MockTarget: forced revert");
        lastValue = msg.value;
        lastData = msg.data;
        return x * 2;
    }

    receive() external payable {}
}
```

- [ ] **Step 2: Write the failing test file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockTarget} from "./mocks/MockTarget.sol";

contract AgentVaultTest is Test {
    AgentVault vault;
    MockTarget target;

    address owner = address(this);
    address agent = address(0xA6E27);
    address stranger = address(0xBAD);

    uint256 constant PER_TX = 1 ether;
    uint256 constant DAILY = 3 ether;

    function setUp() public {
        vault = new AgentVault(agent, PER_TX, DAILY);
        target = new MockTarget();
        vault.setAllowedTarget(address(target), true);
        // fund the vault
        (bool ok,) = address(vault).call{value: 10 ether}("");
        require(ok, "fund failed");
    }

    function _ping(uint256 x) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("ping(uint256)", x);
    }

    function test_onlyAgentCanExecute() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("not agent"));
        vault.execute(address(target), 0, _ping(1), "should fail");
    }

    function test_agentCanExecuteAllowedTarget() public {
        vm.prank(agent);
        vault.execute(address(target), 0.5 ether, _ping(21), "buy");
        assertEq(target.lastValue(), 0.5 ether);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge test -vvv`
Expected: FAIL — `AgentVault` source does not exist / does not compile.

### Task 1.3: Implement `AgentVault` to pass the access + execute tests

**Files:**
- Create: `contracts/src/AgentVault.sol`

- [ ] **Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentVault
/// @notice Holds funds an AI agent may spend on-chain under hard limits.
///         Every action is recorded on-chain via AgentDecision for the hackathon benchmark.
contract AgentVault {
    address public owner;            // human owner
    address public agent;            // the AI agent's key (session key)
    uint256 public spendLimitPerTx;  // max wei per single action
    uint256 public dailyLimit;       // max wei spent per rolling 24h window
    uint256 public spentToday;       // wei spent in the current window
    uint256 public windowStart;      // unix ts when the current window began
    bool public paused;              // owner kill switch
    uint256 public nonce;            // increments per executed decision

    mapping(address => bool) public allowedTarget;

    event AgentDecision(
        uint256 indexed nonce,
        address indexed target,
        uint256 value,
        bytes data,
        string rationale
    );
    event Deposited(address indexed from, uint256 amount);
    event TargetAllowed(address indexed target, bool allowed);
    event PausedSet(bool paused);

    error NotOwner();
    error NotAgent();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address _agent, uint256 _spendLimitPerTx, uint256 _dailyLimit) {
        owner = msg.sender;
        agent = _agent;
        spendLimitPerTx = _spendLimitPerTx;
        dailyLimit = _dailyLimit;
        windowStart = block.timestamp;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function setAllowedTarget(address t, bool ok) external onlyOwner {
        allowedTarget[t] = ok;
        emit TargetAllowed(t, ok);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    /// @notice The agent executes one decision against an allowed target.
    function execute(address target, uint256 value, bytes calldata data, string calldata rationale)
        external
        onlyAgent
        returns (bytes memory)
    {
        require(!paused, "paused");
        require(allowedTarget[target], "target not allowed");
        require(value <= spendLimitPerTx, "over per-tx limit");

        _rollWindow();
        require(spentToday + value <= dailyLimit, "over daily limit");
        spentToday += value;

        emit AgentDecision(nonce, target, value, data, rationale);
        nonce += 1;

        (bool success, bytes memory ret) = target.call{value: value}(data);
        require(success, "call failed");
        return ret;
    }

    function _rollWindow() internal {
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentToday = 0;
        }
    }
}
```

Note: the test asserts `vm.expectRevert(bytes("not agent"))`. Update the test in Task 1.2 to use the custom error instead, OR keep a string — for consistency with this implementation, change the test's expectation in Task 1.4 below (we use the custom error `NotAgent`).

- [ ] **Step 2: Run tests**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge test -vvv`
Expected: `test_onlyAgentCanExecute` may FAIL on the revert string mismatch (custom error vs string). Proceed to Task 1.4 to align, then it passes along with `test_agentCanExecuteAllowedTarget`.

### Task 1.4: Align the access-control test to the custom error

**Files:**
- Modify: `contracts/test/AgentVault.t.sol` (the `test_onlyAgentCanExecute` body)

- [ ] **Step 1: Replace the expectRevert line**

Change:
```solidity
        vm.expectRevert(bytes("not agent"));
```
to:
```solidity
        vm.expectRevert(AgentVault.NotAgent.selector);
```

- [ ] **Step 2: Run tests to verify both pass**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge test -vvv`
Expected: PASS — `test_onlyAgentCanExecute`, `test_agentCanExecuteAllowedTarget`.

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/src/AgentVault.sol contracts/test/AgentVault.t.sol contracts/test/mocks/MockTarget.sol
git commit -m "feat(contracts): AgentVault with agent-only allowlisted execution"
```

### Task 1.5: Test + enforce per-tx limit, daily limit, pause, allowlist (TDD)

**Files:**
- Modify: `contracts/test/AgentVault.t.sol` (add tests)

- [ ] **Step 1: Add the failing tests**

```solidity
    function test_revertsOverPerTxLimit() public {
        vm.prank(agent);
        vm.expectRevert(bytes("over per-tx limit"));
        vault.execute(address(target), PER_TX + 1, _ping(1), "too big");
    }

    function test_revertsOverDailyLimit() public {
        // three 1-ether spends = 3 ether (== daily). Fourth must revert.
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agent);
            vault.execute(address(target), 1 ether, _ping(1), "ok");
        }
        vm.prank(agent);
        vm.expectRevert(bytes("over daily limit"));
        vault.execute(address(target), 1, _ping(1), "over");
    }

    function test_dailyLimitResetsAfter24h() public {
        // Reach the daily cap with three 1-ether spends (each within the per-tx limit).
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agent);
            vault.execute(address(target), 1 ether, _ping(1), "max");
        }
        assertEq(vault.spentToday(), 3 ether);
        // After the window rolls, a fresh spend is allowed and spentToday resets.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        vault.execute(address(target), 1 ether, _ping(1), "next window");
        assertEq(vault.spentToday(), 1 ether);
    }

    function test_revertsWhenPaused() public {
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(bytes("paused"));
        vault.execute(address(target), 0, _ping(1), "blocked");
    }

    function test_revertsDisallowedTarget() public {
        MockTarget other = new MockTarget();
        vm.prank(agent);
        vm.expectRevert(bytes("target not allowed"));
        vault.execute(address(other), 0, _ping(1), "not allowed");
    }

    function test_emitsAgentDecisionWithRationale() public {
        vm.expectEmit(true, true, false, true);
        emit AgentVault.AgentDecision(0, address(target), 0.1 ether, _ping(7), "rebalance");
        vm.prank(agent);
        vault.execute(address(target), 0.1 ether, _ping(7), "rebalance");
    }
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge test -vvv`
Expected: PASS for all — the Task 1.3 implementation already enforces these rules. (If any fail, fix `AgentVault.sol` until green; do not weaken the tests.)

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/test/AgentVault.t.sol
git commit -m "test(contracts): cover limits, pause, allowlist, decision event"
```

### Task 1.6: Codex security review of the contract

- [ ] **Step 1: Run a Codex review on the contract**

At the Claude Code prompt (not bash), run:
```
/codex:review
```
Expected: a read-only review. Address any real findings (reentrancy, missing checks). The `execute` call uses checks-effects-interactions (state updated + event emitted before the external call), so reentrancy risk is low — but confirm with the reviewer.

- [ ] **Step 2: Commit any fixes**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/
git commit -m "fix(contracts): address codex review findings"
```

---

## Phase 2 — Deploy to Mantle Sepolia

**Goal:** a live, funded `AgentVault` on Mantle Sepolia with its address written to `shared/addresses.json`.

### Task 2.1: Write the deploy script

**Files:**
- Create: `contracts/script/Deploy.s.sol`

- [ ] **Step 1: Write the script**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));

        // Conservative testnet limits: 0.05 MNT per tx, 0.2 MNT per day.
        uint256 perTx = 0.05 ether;
        uint256 daily = 0.2 ether;

        vm.startBroadcast(deployerKey);
        AgentVault vault = new AgentVault(agent, perTx, daily);
        // seed the vault so the agent has something to act with
        (bool ok,) = address(vault).call{value: 0.2 ether}("");
        require(ok, "seed failed");
        vm.stopBroadcast();

        console.log("AgentVault deployed at:", address(vault));
        console.log("Agent address:", agent);
        console.log("Deploy block:", block.number); // record this in shared/addresses.json
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge build`
Expected: `Compiler run successful`.

### Task 2.2: Deploy and record the address

- [ ] **Step 1: Load env and deploy**

Run (from repo root; ensure `.env` is filled and both keys funded):
```bash
cd /Users/gautam/Desktop/Turing-Hackathon
set -a && source .env && set +a
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "$MANTLE_RPC_URL" --broadcast
```
Expected: console prints `AgentVault deployed at: 0x...` and a successful broadcast.

- [ ] **Step 2: Record the deployed address**

Edit `shared/addresses.json` — set `agentVault` to the printed address, `deployBlock` to the printed deploy block, and confirm `chainId` matches (5003). The dashboard reads `deployBlock` to bound its log query. Example:
```json
{
  "chainId": 5003,
  "agentVault": "0xYourDeployedVaultAddress",
  "deployBlock": 12345678
}
```

- [ ] **Step 3: Confirm on the explorer**

Open `https://explorer.sepolia.mantle.xyz/address/0xYourDeployedVaultAddress` and verify the contract exists and holds the seed balance.

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/script/Deploy.s.sol shared/addresses.json
git commit -m "feat(contracts): deploy AgentVault to Mantle Sepolia"
```

---

## Phase 3 — Agent Runtime: observe → reason → act

**Goal:** a TypeScript loop where Claude proposes an action, a guard validates it, and viem submits it through the vault. Pure logic (parsing, policy) is TDD; chain I/O is integration-tested live.

### Task 3.1: Scaffold the agent package

**Files:**
- Create: `agent/package.json`
- Create: `agent/tsconfig.json`
- Create: `agent/vitest.config.ts`

- [ ] **Step 1: Write `agent/package.json`**

```json
{
  "name": "mantle-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "start": "tsx src/agent.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "viem": "^2.21.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `agent/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
});
```

- [ ] **Step 4: Install**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npm install`
Expected: dependencies installed, no errors. (If `@anthropic-ai/sdk` version differs, accept the latest 0.x — adjust import usage in Task 3.4 if the SDK surface changed.)

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/package.json agent/tsconfig.json agent/vitest.config.ts agent/package-lock.json
git commit -m "chore(agent): scaffold typescript package"
```

### Task 3.2: Shared types

**Files:**
- Create: `agent/src/types.ts`

- [ ] **Step 1: Write the types**

```typescript
export type Decision =
  | { kind: "hold"; rationale: string }
  | {
      kind: "execute";
      target: `0x${string}`;
      valueWei: bigint;
      calldata: `0x${string}`;
      rationale: string;
    };

export interface VaultState {
  balanceWei: bigint;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  paused: boolean;
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/types.ts
git commit -m "feat(agent): shared Decision and VaultState types"
```

### Task 3.3: Client-side policy guard (TDD)

**Files:**
- Create: `agent/src/policy.test.ts`
- Create: `agent/src/policy.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { checkPolicy } from "./policy.js";
import type { Decision, VaultState } from "./types.js";

const state: VaultState = {
  balanceWei: 1_000_000n,
  spendLimitPerTx: 100n,
  dailyLimit: 250n,
  spentToday: 200n,
  paused: false,
};

const exec = (valueWei: bigint): Decision => ({
  kind: "execute",
  target: "0x1111111111111111111111111111111111111111",
  valueWei,
  calldata: "0x",
  rationale: "test",
});

describe("checkPolicy", () => {
  it("allows a spend within all limits", () => {
    expect(checkPolicy(exec(40n), state).ok).toBe(true);
  });
  it("rejects over per-tx limit", () => {
    expect(checkPolicy(exec(101n), state).ok).toBe(false);
  });
  it("rejects when it would exceed the daily limit", () => {
    // spentToday 200 + 60 = 260 > 250
    const r = checkPolicy(exec(60n), state);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/daily/i);
  });
  it("rejects when paused", () => {
    expect(checkPolicy(exec(10n), { ...state, paused: true }).ok).toBe(false);
  });
  it("rejects spend exceeding balance", () => {
    expect(checkPolicy(exec(10n), { ...state, balanceWei: 5n }).ok).toBe(false);
  });
  it("always allows hold", () => {
    expect(checkPolicy({ kind: "hold", rationale: "wait" }, state).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npm test`
Expected: FAIL — `checkPolicy` is not defined.

- [ ] **Step 3: Implement `policy.ts`**

```typescript
import type { Decision, VaultState, PolicyResult } from "./types.js";

/// Mirrors AgentVault's on-chain checks so the agent never submits a doomed tx.
/// The contract remains the source of truth; this is a client-side pre-flight.
export function checkPolicy(decision: Decision, state: VaultState): PolicyResult {
  if (decision.kind === "hold") return { ok: true };

  if (state.paused) return { ok: false, reason: "vault is paused" };
  if (decision.valueWei > state.spendLimitPerTx)
    return { ok: false, reason: "over per-tx limit" };
  if (state.spentToday + decision.valueWei > state.dailyLimit)
    return { ok: false, reason: "over daily limit" };
  if (decision.valueWei > state.balanceWei)
    return { ok: false, reason: "insufficient vault balance" };

  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npm test`
Expected: PASS — all 6 `checkPolicy` tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/policy.ts agent/src/policy.test.ts
git commit -m "feat(agent): client-side policy guard mirroring the contract"
```

### Task 3.4: Claude decision parsing via tool use (TDD the parser)

**Files:**
- Create: `agent/src/brain.test.ts`
- Create: `agent/src/brain.ts`

We test the *parsing* of a Claude tool-use response into a `Decision` (deterministic, mockable). The live LLM call is exercised in Phase 4.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseToolUse } from "./brain.js";

const SINK = "0x2222222222222222222222222222222222222222" as const;

describe("parseToolUse", () => {
  it("maps a high-level pay intent to a contract-faithful execute Decision", () => {
    const d = parseToolUse(
      { action: "pay", amountMnt: "0.001", memo: "demo", rationale: "yield is favorable" },
      SINK,
    );
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.target).toBe(SINK);
      expect(d.valueWei).toBe(1_000_000_000_000_000n); // 0.001 ether in wei
      expect(d.calldata.startsWith("0x")).toBe(true); // calldata is ENCODED in code, not by the LLM
      expect(d.rationale).toBe("yield is favorable");
    }
  });

  it("parses a hold proposal", () => {
    const d = parseToolUse({ action: "hold", rationale: "uncertain" }, SINK);
    expect(d.kind).toBe("hold");
    expect(d.rationale).toBe("uncertain");
  });

  it("throws on a pay proposal missing fields", () => {
    expect(() => parseToolUse({ action: "pay", rationale: "x" }, SINK)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npm test`
Expected: FAIL — `parseToolUse` not defined.

- [ ] **Step 3: Implement `brain.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { encodeFunctionData, parseEther } from "viem";
import type { Decision, VaultState } from "./types.js";

// The agent's only on-chain action: pay the allowlisted treasury sink.
export const SINK_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [{ name: "memo", type: "string" }],
    outputs: [],
  },
] as const;

// The LLM proposes a HIGH-LEVEL intent (amount + memo). It never writes raw
// calldata or wei — the agent encodes those in code so the tx is always well-formed.
export const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "Propose the agent's next action: pay the treasury sink, or hold. " +
    "Respect the vault's per-tx and daily limits.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["pay", "hold"] },
      amountMnt: { type: "string", description: 'amount of MNT to pay, decimal string e.g. "0.001" (pay only)' },
      memo: { type: "string", description: "short memo recorded on-chain (pay only)" },
      rationale: { type: "string", description: "why this action" },
    },
    required: ["action", "rationale"],
  },
};

/// Pure mapping: tool input + the allowlisted sink address -> a contract-faithful
/// Decision. Calldata and wei are computed HERE, not by the LLM. Throws on malformed pay.
export function parseToolUse(input: any, sink: `0x${string}`): Decision {
  if (input?.action === "hold") {
    return { kind: "hold", rationale: String(input.rationale ?? "") };
  }
  if (input?.action === "pay") {
    if (input.amountMnt === undefined || input.memo === undefined) {
      throw new Error("pay proposal missing amountMnt/memo");
    }
    return {
      kind: "execute",
      target: sink,
      valueWei: parseEther(String(input.amountMnt)),
      calldata: encodeFunctionData({ abi: SINK_ABI, functionName: "pay", args: [String(input.memo)] }),
      rationale: String(input.rationale ?? ""),
    };
  }
  throw new Error(`unknown action: ${input?.action}`);
}

/// Calls Claude with the propose_action tool and returns a parsed Decision.
export async function decide(
  client: Anthropic,
  state: VaultState,
  context: string,
  sink: `0x${string}`,
): Promise<Decision> {
  const sys =
    "You are an autonomous treasury agent for a smart-contract vault on Mantle. " +
    "Each turn you may pay the treasury sink a small amount of MNT, or hold. " +
    "Never propose an amount above the per-tx or remaining daily limit. " +
    `Vault: balance=${state.balanceWei} wei, perTxLimit=${state.spendLimitPerTx} wei, ` +
    `dailyLimit=${state.dailyLimit} wei, spentToday=${state.spentToday} wei, paused=${state.paused}.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
    tools: [PROPOSE_ACTION_TOOL],
    tool_choice: { type: "tool", name: "propose_action" },
    messages: [{ role: "user", content: context }],
  });

  const toolUse = msg.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("model did not call propose_action");
  }
  return parseToolUse(toolUse.input, sink);
}
```

- [ ] **Step 4: Run to verify parser tests pass**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npm test`
Expected: PASS — all `parseToolUse` tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/brain.ts agent/src/brain.test.ts
git commit -m "feat(agent): Claude tool-use decision + tested parser"
```

### Task 3.5: Config + chain layer (viem)

**Files:**
- Create: `agent/src/config.ts`
- Create: `agent/src/chain.ts`

- [ ] **Step 1: Write `config.ts`**

```typescript
import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantleSepoliaTestnet } from "viem/chains";
// `with { type: "json" }` is the current import-attribute syntax; `assert` is deprecated in Node 22+.
import addresses from "../../shared/addresses.json" with { type: "json" };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const chain = mantleSepoliaTestnet;
export const vaultAddress = addresses.agentVault as `0x${string}`;
export const sinkAddress = addresses.paymentSink as `0x${string}`;

export const agentAccount = privateKeyToAccount(env("AGENT_PRIVATE_KEY") as `0x${string}`);

export const publicClient = createPublicClient({
  chain,
  transport: http(env("MANTLE_RPC_URL")),
});

export const walletClient = createWalletClient({
  account: agentAccount,
  chain,
  transport: http(env("MANTLE_RPC_URL")),
});
```

- [ ] **Step 2: Write `chain.ts`** (read vault state + send execute)

```typescript
import { publicClient, walletClient, vaultAddress, agentAccount } from "./config.js";
import type { VaultState, Decision } from "./types.js";

export const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "rationale", type: "string" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

export async function readVaultState(): Promise<VaultState> {
  const [balanceWei, spendLimitPerTx, dailyLimit, spentToday, paused] = await Promise.all([
    publicClient.getBalance({ address: vaultAddress }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "spendLimitPerTx" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "dailyLimit" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "spentToday" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "paused" }),
  ]);
  return {
    balanceWei,
    spendLimitPerTx: spendLimitPerTx as bigint,
    dailyLimit: dailyLimit as bigint,
    spentToday: spentToday as bigint,
    paused: paused as boolean,
  };
}

export async function submitExecute(d: Extract<Decision, { kind: "execute" }>): Promise<`0x${string}`> {
  const hash = await walletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "execute",
    args: [d.target, d.valueWei, d.calldata, d.rationale],
    account: agentAccount,
  });
  // waitForTransactionReceipt does NOT throw on revert — it resolves with status
  // 'reverted'. Check it explicitly so a failed on-chain action isn't logged as success.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`execute tx reverted on-chain: ${hash}`);
  }
  return hash;
}
```

- [ ] **Step 3: Type-check**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/config.ts agent/src/chain.ts
git commit -m "feat(agent): viem config and vault read/execute layer"
```

### Task 3.6: (Timeboxed spike) Evaluate Byreal Skills CLI — 60 min max

- [ ] **Step 1: Investigate**

Find the Byreal Skills CLI docs (linked from the hackathon track page / Mantle devhub `https://devhub.mantle.xyz`). Spend at most 60 minutes determining: does it provide an agent-wallet primitive or action templates we can wrap as an allowed `target` in our vault?

- [ ] **Step 2: Decide**

- If it cleanly maps to "a contract our agent calls" → add it as an allowed target via `setAllowedTarget` and use its calldata in `brain.ts` action proposals. Note this in the README as track-aligned tooling.
- If it's immature/undocumented → STOP. The core agent already works on plain viem. Mention in the submission that the design is Byreal-compatible (any allowlisted target works) without making it a dependency.

- [ ] **Step 3: Record the decision** in `CLAUDE.md` under a new `## Byreal` heading (one or two lines) and commit.

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add CLAUDE.md
git commit -m "docs: record Byreal Skills CLI evaluation outcome"
```

---

## Phase 4 — The Autonomous Loop (live integration)

**Goal:** wire observe→decide→guard→execute→log into one runnable agent and prove it transacts on Mantle Sepolia.

### Task 4.1: Write the agent loop

**Files:**
- Create: `agent/src/agent.ts`

- [ ] **Step 1: Write `agent.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { readVaultState, submitExecute } from "./chain.js";
import { decide } from "./brain.js";
import { checkPolicy } from "./policy.js";
import { chain, sinkAddress } from "./config.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

async function tick(context: string): Promise<void> {
  const state = await readVaultState();
  console.log("[state]", {
    balance: state.balanceWei.toString(),
    spentToday: state.spentToday.toString(),
    paused: state.paused,
  });

  const decision = await decide(client, state, context, sinkAddress);
  console.log("[decision]", decision.kind, "-", decision.rationale);

  if (decision.kind === "hold") return;

  const policy = checkPolicy(decision, state);
  if (!policy.ok) {
    console.log("[guard] blocked:", policy.reason);
    return;
  }

  const hash = await submitExecute(decision);
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[executed]", `${base}/tx/${hash}`);
}

async function main() {
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? "60000");
  const context =
    process.env.AGENT_CONTEXT ??
    "Market is stable. Maintain the vault. Only act if there is a clear, low-risk reason.";

  console.log("[agent] starting on", chain.name);

  // Chain ticks with setTimeout (not setInterval) and an in-flight guard, so a slow
  // tick (LLM call + tx confirmation can exceed the interval) never overlaps the next
  // one — overlapping ticks would race on the account nonce and double-submit.
  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try {
        await tick(context);
      } catch (e) {
        console.error("[tick error]", e);
      } finally {
        running = false;
      }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/agent && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/agent.ts
git commit -m "feat(agent): autonomous observe-decide-guard-execute loop"
```

### Task 4.2: Add a real allowed target + prove a live transaction

To get a *visible* on-chain action, add a simple "sink" contract the agent can pay (simulating spending into a strategy/recipient).

**Files:**
- Create: `contracts/src/PaymentSink.sol`
- Modify: `contracts/script/Deploy.s.sol` (deploy + allow the sink)

- [ ] **Step 1: Write `PaymentSink.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal recipient the agent can pay, to demonstrate a real on-chain action.
contract PaymentSink {
    event Received(address indexed from, uint256 amount, string memo);

    function pay(string calldata memo) external payable {
        emit Received(msg.sender, msg.value, memo);
    }
}
```

- [ ] **Step 2: Extend the deploy script to deploy + allowlist the sink**

Append inside `Deploy.run()` before `vm.stopBroadcast()`:
```solidity
        PaymentSink sink = new PaymentSink();
        vault.setAllowedTarget(address(sink), true);
        console.log("PaymentSink deployed at:", address(sink));
```
And add the import at the top:
```solidity
import {PaymentSink} from "../src/PaymentSink.sol";
```

- [ ] **Step 3: Re-test contracts** (the sink shouldn't break existing tests)

Run: `cd /Users/gautam/Desktop/Turing-Hackathon/contracts && forge test -vvv`
Expected: PASS (all prior tests still green).

- [ ] **Step 4: Re-deploy and update addresses**

Run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon
set -a && source .env && set +a
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "$MANTLE_RPC_URL" --broadcast
```
Update `shared/addresses.json`: set `agentVault` to the NEW vault address, `paymentSink` to the printed PaymentSink address, and `deployBlock` to the printed deploy block. The agent reads `paymentSink` (via `config.sinkAddress`) as its only action target; the LLM proposes an amount + memo and the agent encodes the `pay(memo)` calldata itself.

- [ ] **Step 5: Run the agent with a context that triggers a pay**

Set in `.env` an `AGENT_CONTEXT` that asks for a tiny payment within limits (the agent already knows its target is the sink — do NOT ask the LLM for addresses or calldata):
```
AGENT_CONTEXT=Pay 0.001 MNT to the treasury sink with memo "demo" — this is within the per-tx and daily limits.
```
Then run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon/agent
set -a && source ../.env && set +a
npm start
```
Expected: logs show `[decision] execute`, `[guard]` passes, `[executed] https://explorer.sepolia.mantle.xyz/tx/0x...`.

- [ ] **Step 6: Verify on-chain**

Open the printed tx URL. Confirm the `AgentVault.AgentDecision` event AND the `PaymentSink.Received` event are emitted. This is your core proof. Screenshot it.

- [ ] **Step 7: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/src/PaymentSink.sol contracts/script/Deploy.s.sol shared/addresses.json
git commit -m "feat: PaymentSink target + live agent transaction on Mantle Sepolia"
```

---

## Phase 5 — Dashboard (community-vote + UI/UX asset)

**Goal:** a Next.js page that reads `AgentDecision` events from the vault and renders a live feed of the agent's decisions with rationale and explorer links. Verified manually (no UI unit tests — not worth the time).

### Task 5.1: Scaffold Next.js + event reader

**Files:**
- Create: `web/package.json`
- Create: `web/lib/events.ts`
- Create: `web/app/page.tsx`

- [ ] **Step 1: Write `web/package.json`**

```json
{
  "name": "mantle-agent-web",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "viem": "^2.21.0"
  }
}
```

- [ ] **Step 2: Write `web/lib/events.ts`**

```typescript
import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
// Next.js resolves JSON imports natively — no import attribute needed.
import addresses from "../../shared/addresses.json";

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  // Falls back to the chain's default RPC if MANTLE_RPC_URL is unset.
  transport: http(process.env.MANTLE_RPC_URL),
});

const DECISION_EVENT = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);

export interface DecisionLog {
  nonce: string;
  target: string;
  value: string;
  rationale: string;
  txHash: string;
}

export async function getDecisions(): Promise<DecisionLog[]> {
  // Query from the deploy block (recorded at deploy time), NOT "earliest" —
  // public Mantle RPCs cap eth_getLogs block ranges and reject genesis-to-latest scans.
  const logs = await client.getLogs({
    address: addresses.agentVault as `0x${string}`,
    event: DECISION_EVENT,
    fromBlock: BigInt(addresses.deployBlock ?? 0),
  });
  return logs
    .map((l) => ({
      nonce: l.args.nonce?.toString() ?? "",
      target: l.args.target ?? "",
      value: l.args.value?.toString() ?? "0",
      rationale: l.args.rationale ?? "",
      txHash: l.transactionHash ?? "",
    }))
    .reverse();
}
```

- [ ] **Step 3: Write `web/app/page.tsx`**

```tsx
import { getDecisions } from "../lib/events";

export const dynamic = "force-dynamic";

export default async function Page() {
  const decisions = await getDecisions();
  const explorer = "https://explorer.sepolia.mantle.xyz";
  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 820, margin: "40px auto", padding: 16 }}>
      <h1>🤖 Autonomous Agent Wallet — Live Decisions (Mantle)</h1>
      <p style={{ color: "#666" }}>
        Every action this AI agent takes is recorded on-chain. {decisions.length} decisions so far.
      </p>
      {decisions.map((d) => (
        <div key={d.nonce} style={{ border: "1px solid #eee", borderRadius: 12, padding: 16, marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>#{d.nonce} → {d.target}</div>
          <div>Value: {d.value} wei</div>
          <div style={{ marginTop: 8, fontStyle: "italic" }}>“{d.rationale}”</div>
          <a href={`${explorer}/tx/${d.txHash}`} target="_blank" rel="noreferrer">View on explorer ↗</a>
        </div>
      ))}
    </main>
  );
}
```

- [ ] **Step 4: Install + run dev server**

Run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon/web && npm install && npm run dev
```
Open `http://localhost:3000`. Expected: the feed shows the decision(s) from Phase 4 with rationale and a working explorer link.

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add web/package.json web/lib/events.ts web/app/page.tsx web/package-lock.json
git commit -m "feat(web): live on-chain agent decision dashboard"
```

### Task 5.2: Deploy the dashboard to Vercel (public demo URL)

- [ ] **Step 1: Deploy**

Run:
```bash
cd /Users/gautam/Desktop/Turing-Hackathon/web
npx vercel --prod
```
Follow prompts (link/create project). Expected: a public `https://*.vercel.app` URL serving the live feed.

- [ ] **Step 2: Confirm** the public URL loads the same feed. Save the URL for the submission.

---

## Phase 6 — Submission Package

**Goal:** everything DoraHacks needs to judge you well, hitting track + community vote + UI/UX + finalist buckets.

### Task 6.1: Write the README (judge-facing)

**Files:**
- Create: `/Users/gautam/Desktop/Turing-Hackathon/README.md`

- [ ] **Step 1: Write `README.md`** with these exact sections:

```markdown
# 🤖 Autonomous Agent Wallet on Mantle

**Track:** Agentic Wallets & Economy — Mantle Turing Test Hackathon 2026

## What it is
An AI agent (Claude) that custodies funds in a smart-contract vault on Mantle and transacts
autonomously under hard on-chain safety limits. Every decision — including the agent's natural-
language rationale — is recorded on-chain via the `AgentDecision` event, making the agent's
behavior fully auditable: a literal on-chain benchmark of agentic AI.

## Why it fits the Turing Test theme
The hackathon benchmarks AI agents acting on-chain. Our vault makes the agent's every move and
its reasoning permanently verifiable on Mantle, with a kill switch and spend limits — autonomy
with accountability.

## Architecture
- `contracts/AgentVault.sol` — agent-only execution under per-tx / daily / allowlist / pause guards; emits AgentDecision.
- `agent/` — observe → Claude tool-use decision → client-side guard → submit via viem.
- `web/` — live on-chain decision dashboard.

## Live links
- Vault on explorer: https://explorer.sepolia.mantle.xyz/address/0x...
- Live dashboard: https://....vercel.app
- Demo tx (agent decision on-chain): https://explorer.sepolia.mantle.xyz/tx/0x...

## Safety model
Per-tx limit, rolling 24h daily limit, target allowlist, owner pause/kill switch. The contract is
the source of truth; the agent also pre-checks client-side. Tested with Foundry + vitest.

## Run it
- Contracts: `cd contracts && forge test`
- Agent: `cd agent && npm test && npm start`
- Dashboard: `cd web && npm run dev`
```

Fill in the real addresses/URLs from Phases 2, 4, 5.

- [ ] **Step 2: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add README.md
git commit -m "docs: judge-facing README"
```

### Task 6.2: Final adversarial review with Codex

- [ ] **Step 1: Pressure-test the design**

At the Claude Code prompt:
```
/codex:adversarial-review challenge the agent-wallet safety model: can the agent or a malicious target drain funds, bypass limits, or grief the owner?
```
Address any real findings (e.g., reentrancy via a malicious allowed target, daily-window edge cases). Re-run `forge test` after fixes.

- [ ] **Step 2: Commit fixes**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add -A
git commit -m "fix: address adversarial review findings"
```

### Task 6.3: Record the demo video

- [ ] **Step 1: Script a 2–3 minute screen recording** showing, in order:
  1. The dashboard with live decisions.
  2. Running `npm start` — agent observes, Claude decides, guard passes, tx submits.
  3. The tx on the Mantle explorer showing `AgentDecision` (with rationale) + `Received`.
  4. Trigger a guard block (set a context that exceeds the per-tx limit) to show safety working.
  5. The owner pause switch blocking the agent.

- [ ] **Step 2: Record and upload** (YouTube/Loom unlisted). Save the link.

### Task 6.4: Submit on DoraHacks

- [ ] **Step 1: Push the repo to GitHub**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
gh repo create mantle-agentic-wallet --public --source=. --push
```

- [ ] **Step 2: Create the BUIDL** on `https://dorahacks.io/hackathon/mantleturingtesthackathon2026` with: title, the README content, GitHub link, live dashboard URL, demo video link, and the explorer links proving on-chain activity. Select the **Agentic Wallets & Economy** track.

- [ ] **Step 3: Confirm submission** is visible and the deadline isn't missed. (Verify the Phase 2 deadline on the hackathon page — Phase 1 "ClawHack" started Apr 15; confirm Phase 2 dates before relying on them.)

---

## Self-Review (run against the spec)

**Spec coverage:**
- "Set up Claude Code for this" → Phase 0 (CLAUDE.md, codex config, env, scaffold). ✓
- "Use ECC / figure best setup" → Decision recorded: lean curated setup, codex plugin + cherry-picked rules, NOT full ECC install (token-bloat risk noted in Phase 0 intro). ✓
- "Mantle hackathon, autonomous agents on-chain" → AgentVault + agent loop + on-chain AgentDecision log directly serve the track theme. ✓
- "From ideation till execution" → ideation (track + concept chosen with rationale), build (Phases 1–5), submission (Phase 6). ✓
- Prize-bucket coverage → track (autonomous on-chain agent), community vote + UI/UX (dashboard, Phase 5), finalist $1K (deployed + working, Phases 2/4), Grand Champion shot (on-theme + safety model + adversarial review). ✓

**Type consistency check:**
- `Decision` (`kind: "hold" | "execute"`) used identically in `types.ts`, `policy.ts`, `policy.test.ts`, `brain.ts`, `brain.test.ts`, `agent.ts`. ✓
- `VaultState` fields (`balanceWei`, `spendLimitPerTx`, `dailyLimit`, `spentToday`, `paused`) match between `types.ts`, `chain.ts` (`readVaultState`), and `policy.ts`. ✓
- Contract `AgentDecision(nonce, target, value, data, rationale)` matches the web reader's `parseAbiItem` signature and the forge `expectEmit` test. ✓
- `execute(address,uint256,bytes,string)` signature matches between `AgentVault.sol`, the `VAULT_ABI` in `chain.ts`, and the forge tests. ✓
- Custom error `NotAgent` defined in `AgentVault.sol` and referenced in the aligned test (Task 1.4). ✓

**Known external unknowns (handled, not placeholders):**
- Mantle network params → verified in Task 0.5 before any deploy.
- Byreal Skills CLI → timeboxed spike (Task 3.6) with a no-dependency fallback.
- `@anthropic-ai/sdk` exact version surface → Task 3.1 note to adjust import if the 0.x surface changed.
```
