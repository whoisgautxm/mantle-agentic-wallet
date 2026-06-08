# Tiered Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the autonomous Agent Wallet from a "pay-a-sink" MVP into a believable on-chain trading agent with a live, intelligent-looking demo, a measurable benchmark, and a Human-vs-AI comparison — covering Tiers 1–4 with working code and Tier 5 as a design roadmap.

**Architecture:** Build on the existing `AgentVault` (unchanged core). Add a self-contained **`MockDEX`** (internal token ledger + owner-settable price) as the agent's real economic venue — no third-party protocol dependency, fully testable, and any real Mantle DEX can later be dropped in by allowlisting it. The agent's action vocabulary expands from `pay/hold` to **`buy/sell/hold`** (still: LLM proposes a high-level intent, the agent encodes calldata in code). A **price keeper** script simulates market movement; the agent reasons over recent price history. A second `AgentVault` runs a **deterministic DCA "human baseline"** for Human-vs-AI. The dashboard gains **PnL/price charts, a decision-replay feed, live refresh, and dark mode**, reconstructing portfolio value over time from on-chain events. A **circuit breaker** (drawdown auto-pause) and **Telegram alerts** round out safety/observability.

**Tech Stack:** Existing — Solidity ^0.8.24 (Foundry), TypeScript + viem + `@anthropic-ai/sdk` (Claude Sonnet 4.6) + vitest, Next.js 15. Added — `recharts` (dashboard charts). Target chain: Mantle Sepolia (chainId 5003).

---

## Key Decisions (read first)

1. **Self-contained `MockDEX`, not a third-party protocol.** Reliability over realism for the hackathon. The DEX keeps an *internal* token balance ledger (no separate ERC-20, no approvals) and an owner-set `price`. Buying sends MNT and credits tokens; selling debits tokens and returns MNT. Swapping to a real Mantle DEX later = allowlist its address + change the encoded calldata in `agent/src/dex.ts`.
2. **Action vocabulary `buy | sell | hold`.** The LLM still only proposes intent (amount + side); the agent encodes `MockDEX.buy()` / `MockDEX.sell(amount)` calldata in code (no LLM-authored calldata). Maps onto the existing `AgentVault.execute(target,value,data,rationale)` and `Decision` shape, so `policy.ts`/`chain.ts`/`submitExecute` change minimally.
3. **Human-vs-AI = two vaults, same DEX.** The AI vault is Claude-driven; the baseline vault is a deterministic DCA rule. Both reuse the *same* `AgentVault` contract — no new vault contract. The dashboard compares their portfolio value.
4. **PnL reconstructed from events**, not a trusted off-chain store: `MockDEX` emits `PriceSet`, `Bought`, `Sold`; the dashboard rebuilds each vault's token balance and portfolio value timeline from logs. This *is* the "on-chain benchmark" story.
5. **Tiers 1–4 are fully specified with code + tests. Tier 5 is a design roadmap** (ERC-4337 session keys, real-protocol swap-in, multi-agent leaderboard, mainnet) — intentionally NOT decomposed into bite-sized code tasks, because each is a multi-week effort whose "exact code" would be speculative. Implement Tiers 1–4; treat Tier 5 as documented direction.

**Prerequisite:** the existing repo (contracts 15/15, agent 11/11, web builds) at `/Users/gautam/Desktop/Turing-Hackathon`. Each phase below is independently shippable and demoable.

---

## File Structure

```
contracts/
  src/MockDEX.sol                 # NEW: internal-ledger swap venue + price
  test/MockDEX.t.sol              # NEW
  script/Deploy.s.sol             # MODIFY: deploy DEX, two vaults, allowlist DEX, seed liquidity
agent/src/
  types.ts                        # MODIFY: add token/price to VaultState; keep Decision shape
  dex.ts                          # NEW: DEX ABI + read token balance/price + encode buy/sell
  brain.ts                        # MODIFY: buy|sell|hold intents -> encoded Decision
  brain.test.ts                   # MODIFY
  chain.ts                        # MODIFY: read token balance + price; expose dex reads
  pnl.ts                          # NEW: portfolio value + ROI (pure)  [TDD]
  pnl.test.ts                     # NEW
  policy.ts                       # (unchanged; sells carry value 0)
  agent.ts                        # MODIFY: feed price history; sell-balance guard; circuit breaker
  baseline.ts                     # NEW: deterministic DCA runner (human baseline)
  keeper.ts                       # NEW: price simulator (owner setPrice over time)
  telegram.ts                     # NEW: optional decision alerts  [TDD: message formatting]
  telegram.test.ts                # NEW
web/
  package.json                    # MODIFY: add recharts
  lib/events.ts                   # MODIFY: read PriceSet/Bought/Sold; multi-vault
  lib/pnl.ts                      # NEW: reconstruct portfolio timeline from logs
  app/page.tsx                    # MODIFY: charts, dual-vault PnL, decision replay, dark mode
  app/components/*.tsx            # NEW: chart + feed components
shared/addresses.json            # MODIFY: add mockDex, aiVault, baselineVault, deployBlock
```

---

## Phase 1 — `MockDEX` Contract (Tier 1a) — TDD

**Goal:** a self-contained swap venue the agent can trade against: send MNT to buy tokens, sell tokens for MNT, at an owner-set price; emits events for the benchmark.

### Task 1.1: Failing tests for MockDEX

**Files:**
- Create: `contracts/test/MockDEX.t.sol`

- [ ] **Step 1: Write the test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockDEX} from "../src/MockDEX.sol";

contract MockDEXTest is Test {
    MockDEX dex;
    address user = address(0xU5E2);

    // price = MNT wei per 1 whole token (1e18 token units)
    uint256 constant PRICE = 2 ether; // 2 MNT per token

    function setUp() public {
        dex = new MockDEX(PRICE);
        // seed DEX with MNT liquidity so it can pay out sells
        (bool ok,) = address(dex).call{value: 100 ether}("");
        require(ok, "seed failed");
        vm.deal(user, 10 ether);
    }

    function test_buyCreditsTokensAtPrice() public {
        vm.prank(user);
        dex.buy{value: 1 ether}(); // 1 MNT / 2 = 0.5 token
        assertEq(dex.tokenBalance(user), 0.5 ether);
    }

    function test_sellReturnsMntAtPrice() public {
        vm.prank(user);
        dex.buy{value: 2 ether}(); // 1 token
        uint256 before = user.balance;
        vm.prank(user);
        dex.sell(1 ether); // sell 1 token -> 2 MNT
        assertEq(dex.tokenBalance(user), 0);
        assertEq(user.balance, before + 2 ether);
    }

    function test_sellRevertsOnInsufficientTokens() public {
        vm.prank(user);
        vm.expectRevert(bytes("insufficient tokens"));
        dex.sell(1 ether);
    }

    function test_setPriceOnlyOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        dex.setPrice(3 ether);
    }

    function test_setPriceRejectsZero() public {
        vm.expectRevert(bytes("price=0"));
        dex.setPrice(0);
    }

    function test_priceChangeAffectsBuyAmount() public {
        dex.setPrice(4 ether); // 4 MNT per token
        vm.prank(user);
        dex.buy{value: 4 ether}(); // 1 token
        assertEq(dex.tokenBalance(user), 1 ether);
    }

    function test_constructorRejectsZeroPrice() public {
        vm.expectRevert(bytes("price=0"));
        new MockDEX(0);
    }
}
```

- [ ] **Step 2: Run, confirm RED**

Run: `cd contracts && forge test --match-contract MockDEXTest -vvv`
Expected: FAIL — `MockDEX` not found.

### Task 1.2: Implement MockDEX

**Files:**
- Create: `contracts/src/MockDEX.sol`

- [ ] **Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockDEX
/// @notice Self-contained swap venue with an internal token ledger and an owner-set price.
///         Buying sends MNT and credits tokens; selling debits tokens and returns MNT.
///         No external ERC-20 / approvals — keeps the agent's trade flow simple and testable.
contract MockDEX {
    address public owner;
    uint256 public price; // MNT wei per 1 whole token (1e18 token units)
    mapping(address => uint256) public tokenBalance; // token units, 1e18 == 1 token

    event PriceSet(uint256 price);
    event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price);
    event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 _price) {
        require(_price > 0, "price=0");
        owner = msg.sender;
        price = _price;
        emit PriceSet(_price);
    }

    receive() external payable {} // accept MNT liquidity

    function setPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "price=0");
        price = _price;
        emit PriceSet(_price);
    }

    function buy() external payable {
        require(msg.value > 0, "no value");
        uint256 tokensOut = (msg.value * 1e18) / price;
        tokenBalance[msg.sender] += tokensOut;
        emit Bought(msg.sender, msg.value, tokensOut, price);
    }

    function sell(uint256 tokenAmount) external {
        require(tokenBalance[msg.sender] >= tokenAmount, "insufficient tokens");
        uint256 mntOut = (tokenAmount * price) / 1e18;
        require(address(this).balance >= mntOut, "insufficient liquidity");
        tokenBalance[msg.sender] -= tokenAmount; // effects before interaction (CEI)
        emit Sold(msg.sender, tokenAmount, mntOut, price);
        (bool ok,) = msg.sender.call{value: mntOut}("");
        require(ok, "mnt transfer failed");
    }
}
```

- [ ] **Step 2: Run, confirm GREEN**

Run: `cd contracts && forge test --match-contract MockDEXTest -vvv`
Expected: PASS (7 tests). The existing 15 AgentVault tests must also still pass: `forge test`.

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/src/MockDEX.sol contracts/test/MockDEX.t.sol
git commit -m "feat(contracts): self-contained MockDEX (internal ledger + price) with tests"
```

### Task 1.3: Deploy script — DEX + two vaults + liquidity

**Files:**
- Modify: `contracts/script/Deploy.s.sol`

- [ ] **Step 1: Replace `Deploy.s.sol` with the multi-contract version**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockDEX} from "../src/MockDEX.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address aiAgent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));
        address baselineAgent = vm.addr(vm.envUint("BASELINE_PRIVATE_KEY"));

        uint256 perTx = 0.05 ether;
        uint256 daily = 0.2 ether;
        uint256 startPrice = 2 ether; // 2 MNT per token

        vm.startBroadcast(deployerKey);

        MockDEX dex = new MockDEX(startPrice);
        (bool okDex,) = address(dex).call{value: 0.5 ether}(""); // seed liquidity for sells
        require(okDex, "dex seed failed");

        AgentVault aiVault = new AgentVault(aiAgent, perTx, daily);
        (bool okAi,) = address(aiVault).call{value: 0.2 ether}("");
        require(okAi, "ai seed failed");
        aiVault.setAllowedTarget(address(dex), true);

        AgentVault baselineVault = new AgentVault(baselineAgent, perTx, daily);
        (bool okBl,) = address(baselineVault).call{value: 0.2 ether}("");
        require(okBl, "baseline seed failed");
        baselineVault.setAllowedTarget(address(dex), true);

        vm.stopBroadcast();

        console.log("MockDEX:", address(dex));
        console.log("AI AgentVault:", address(aiVault));
        console.log("Baseline AgentVault:", address(baselineVault));
        console.log("AI agent:", aiAgent);
        console.log("Baseline agent:", baselineAgent);
        console.log("Deploy block:", block.number);
    }
}
```

- [ ] **Step 2: Verify it compiles + all contract tests pass**

Run: `cd contracts && forge build && forge test`
Expected: build OK; 22 tests pass (15 AgentVault + 7 MockDEX). Do NOT broadcast (needs keys).

- [ ] **Step 3: Update `.env.example` and `shared/addresses.json` shapes**

Append to `.env.example`:
```bash
# Baseline (human DCA) agent key — a third testnet key, fund with a little gas
BASELINE_PRIVATE_KEY=0x...
# Optional: Telegram alerts (leave blank to disable)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```
Replace `shared/addresses.json` with:
```json
{
  "chainId": 5003,
  "mockDex": "0x0000000000000000000000000000000000000000",
  "aiVault": "0x0000000000000000000000000000000000000000",
  "baselineVault": "0x0000000000000000000000000000000000000000",
  "deployBlock": 0
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add contracts/script/Deploy.s.sol .env.example shared/addresses.json
git commit -m "feat(contracts): deploy DEX + AI/baseline vaults; update env + addresses shape"
```

> **Note for later config consumers:** `agent/src/config.ts` and `web/lib/events.ts` currently read `agentVault`. They are updated in Phases 2 and 4 to read `aiVault`/`baselineVault`/`mockDex`. Until then the agent won't run against the new shape — that's expected; Phase 2 fixes config.

---

## Phase 2 — Agent Trades: buy/sell/hold + Price Awareness (Tier 1b + Tier 2 data)

**Goal:** the agent reads price + its token holdings, Claude proposes `buy`/`sell`/`hold`, and the agent encodes the DEX calldata in code.

### Task 2.1: Extend `VaultState` and add `dex.ts`

**Files:**
- Modify: `agent/src/types.ts`
- Create: `agent/src/dex.ts`

- [ ] **Step 1: Extend `VaultState` in `types.ts`** (add token + price; keep `Decision` unchanged)

Add these two fields to the `VaultState` interface (after `paused`):
```typescript
  tokenBalanceWei: bigint; // agent's token holdings on the DEX (1e18 == 1 token)
  priceWei: bigint;        // MNT wei per 1 whole token
```

- [ ] **Step 2: Create `agent/src/dex.ts`**

```typescript
import { encodeFunctionData } from "viem";

// MNT wei per 1 whole token (1e18 token units).
export const DEX_ABI = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "tokenBalance", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "buy", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ name: "tokenAmount", type: "uint256" }], outputs: [] },
  { type: "function", name: "setPrice", stateMutability: "nonpayable", inputs: [{ name: "price", type: "uint256" }], outputs: [] },
] as const;

export function encodeBuy(): `0x${string}` {
  return encodeFunctionData({ abi: DEX_ABI, functionName: "buy" });
}

export function encodeSell(tokenAmountWei: bigint): `0x${string}` {
  return encodeFunctionData({ abi: DEX_ABI, functionName: "sell", args: [tokenAmountWei] });
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/types.ts agent/src/dex.ts
git commit -m "feat(agent): DEX ABI + buy/sell calldata encoders; price/token in VaultState"
```

### Task 2.2: Rewrite `brain.ts` for buy/sell/hold (TDD the parser)

**Files:**
- Modify: `agent/src/brain.test.ts`
- Modify: `agent/src/brain.ts`

- [ ] **Step 1: Replace `brain.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseToolUse } from "./brain.js";

const DEX = "0x3333333333333333333333333333333333333333" as const;

describe("parseToolUse", () => {
  it("maps a buy intent to an execute Decision (MNT sent to DEX.buy)", () => {
    const d = parseToolUse({ action: "buy", amountMnt: "0.01", rationale: "price dipped" }, DEX);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(10_000_000_000_000_000n); // 0.01 ether
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.rationale).toBe("price dipped");
    }
  });

  it("maps a sell intent to an execute Decision (0 value, sell calldata)", () => {
    const d = parseToolUse({ action: "sell", amountToken: "0.5", rationale: "take profit" }, DEX);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(0n);
      expect(d.calldata.startsWith("0x")).toBe(true);
    }
  });

  it("parses a hold proposal", () => {
    const d = parseToolUse({ action: "hold", rationale: "uncertain" }, DEX);
    expect(d.kind).toBe("hold");
  });

  it("throws on buy missing amount", () => {
    expect(() => parseToolUse({ action: "buy", rationale: "x" }, DEX)).toThrow();
  });
  it("throws on sell missing amount", () => {
    expect(() => parseToolUse({ action: "sell", rationale: "x" }, DEX)).toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm RED** (signatures changed): `cd agent && npm test`

- [ ] **Step 3: Replace `brain.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { parseEther } from "viem";
import { encodeBuy, encodeSell } from "./dex.js";
import type { Decision, VaultState } from "./types.js";

export const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "Propose the agent's next trade on the DEX: buy tokens with MNT, sell tokens for MNT, or hold. " +
    "Respect the vault's per-tx and daily MNT limits (buys only) and your current token balance (sells only).",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      amountMnt: { type: "string", description: 'MNT to spend buying, decimal string e.g. "0.01" (buy only)' },
      amountToken: { type: "string", description: 'tokens to sell, decimal string e.g. "0.5" (sell only)' },
      rationale: { type: "string", description: "why this action, referencing the price trend" },
    },
    required: ["action", "rationale"],
  },
};

/// Pure mapping: tool input + DEX address -> contract-faithful Decision.
/// Calldata/wei are computed HERE, never by the LLM.
export function parseToolUse(input: any, dex: `0x${string}`): Decision {
  if (input?.action === "hold") {
    return { kind: "hold", rationale: String(input.rationale ?? "") };
  }
  if (input?.action === "buy") {
    if (input.amountMnt === undefined) throw new Error("buy missing amountMnt");
    return {
      kind: "execute",
      target: dex,
      valueWei: parseEther(String(input.amountMnt)),
      calldata: encodeBuy(),
      rationale: String(input.rationale ?? ""),
    };
  }
  if (input?.action === "sell") {
    if (input.amountToken === undefined) throw new Error("sell missing amountToken");
    return {
      kind: "execute",
      target: dex,
      valueWei: 0n,
      calldata: encodeSell(parseEther(String(input.amountToken))),
      rationale: String(input.rationale ?? ""),
    };
  }
  throw new Error(`unknown action: ${input?.action}`);
}

/// Calls Claude with recent price context and returns a parsed Decision.
export async function decide(
  client: Anthropic,
  state: VaultState,
  priceHistory: bigint[],
  dex: `0x${string}`,
): Promise<Decision> {
  const sys =
    "You are an autonomous trading agent for a smart-contract vault on Mantle. " +
    "Each turn you may buy tokens with MNT, sell tokens for MNT, or hold. " +
    "Buy spends MNT (bounded by per-tx and remaining daily limits); sell is bounded by your token balance. " +
    "Trade to grow total portfolio value; be decisive but avoid reckless size. " +
    `State: mntBalance=${state.balanceWei} wei, tokenBalance=${state.tokenBalanceWei}, ` +
    `price=${state.priceWei} wei/token, perTxLimit=${state.spendLimitPerTx} wei, ` +
    `dailyLimit=${state.dailyLimit} wei, spentToday=${state.spentToday} wei, paused=${state.paused}.`;

  const trend = priceHistory.length
    ? `Recent prices (oldest→newest, wei/token): ${priceHistory.join(", ")}.`
    : "No price history yet.";

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
    tools: [PROPOSE_ACTION_TOOL],
    tool_choice: { type: "tool", name: "propose_action" },
    messages: [{ role: "user", content: trend }],
  });

  const toolUse = msg.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("model did not call propose_action");
  return parseToolUse(toolUse.input, dex);
}
```

- [ ] **Step 4: Run, confirm GREEN**: `cd agent && npm test` (5 brain tests + 8 policy tests pass)

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/brain.ts agent/src/brain.test.ts
git commit -m "feat(agent): buy/sell/hold trade decisions over DEX with price context (TDD)"
```

### Task 2.3: Update `config.ts` + `chain.ts` for the new addresses and DEX reads

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/src/chain.ts`

- [ ] **Step 1: Update `config.ts` exports** — replace the `vaultAddress`/`sinkAddress` lines with:

```typescript
export const aiVaultAddress = addresses.aiVault as `0x${string}`;
export const baselineVaultAddress = addresses.baselineVault as `0x${string}`;
export const dexAddress = addresses.mockDex as `0x${string}`;
```
Also add a second account for the baseline runner (after `agentAccount`):
```typescript
export const baselineAccount = privateKeyToAccount(env("BASELINE_PRIVATE_KEY") as `0x${string}`);
export const baselineWalletClient = createWalletClient({
  account: baselineAccount,
  chain,
  transport: http(env("MANTLE_RPC_URL")),
});
```

- [ ] **Step 2: Update `chain.ts`** — generalize reads to take a vault address and add DEX reads. Replace the file body with:

```typescript
import { publicClient, walletClient, agentAccount, dexAddress } from "./config.js";
import { DEX_ABI } from "./dex.js";
import type { VaultState, Decision } from "./types.js";

export const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowedTarget", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setPaused", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  {
    type: "function", name: "execute", stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" }, { name: "value", type: "uint256" },
      { name: "data", type: "bytes" }, { name: "rationale", type: "string" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

export async function readPrice(): Promise<bigint> {
  return (await publicClient.readContract({ address: dexAddress, abi: DEX_ABI, functionName: "price" })) as bigint;
}

export async function readVaultState(vault: `0x${string}`): Promise<VaultState> {
  const [balanceWei, spendLimitPerTx, dailyLimit, spentToday, paused, tokenBalanceWei, priceWei] = await Promise.all([
    publicClient.getBalance({ address: vault }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spendLimitPerTx" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "dailyLimit" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentToday" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" }),
    publicClient.readContract({ address: dexAddress, abi: DEX_ABI, functionName: "tokenBalance", args: [vault] }),
    readPrice(),
  ]);
  return {
    balanceWei,
    spendLimitPerTx: spendLimitPerTx as bigint,
    dailyLimit: dailyLimit as bigint,
    spentToday: spentToday as bigint,
    paused: paused as boolean,
    tokenBalanceWei: tokenBalanceWei as bigint,
    priceWei: priceWei as bigint,
  };
}

export async function isTargetAllowed(vault: `0x${string}`, target: `0x${string}`): Promise<boolean> {
  return (await publicClient.readContract({
    address: vault, abi: VAULT_ABI, functionName: "allowedTarget", args: [target],
  })) as boolean;
}

/// Submit an execute from a given vault using the provided wallet client.
export async function submitExecute(
  vault: `0x${string}`,
  d: Extract<Decision, { kind: "execute" }>,
  client = walletClient,
): Promise<`0x${string}`> {
  const account = client === walletClient ? agentAccount : (client as any).account;
  const hash = await client.writeContract({
    address: vault, abi: VAULT_ABI, functionName: "execute",
    args: [d.target, d.valueWei, d.calldata, d.rationale], account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`execute tx reverted on-chain: ${hash}`);
  return hash;
}

export async function setPaused(vault: `0x${string}`, paused: boolean): Promise<`0x${string}`> {
  // owner-only; uses the deployer/owner wallet. Wire OWNER_PRIVATE_KEY in config if you split roles.
  const hash = await walletClient.writeContract({
    address: vault, abi: VAULT_ABI, functionName: "setPaused", args: [paused], account: agentAccount,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
```

> **Note:** `setPaused` is `onlyOwner`. In the demo the owner is the deployer key. For the circuit breaker (Phase 6) to call `setPaused`, either run the breaker from the owner key or, simpler for the demo, have the breaker just *stop submitting* (soft pause) rather than calling on-chain `setPaused`. Phase 6 uses the soft-pause approach to avoid wiring the owner key into the agent.

- [ ] **Step 3: Typecheck**: `cd agent && npx tsc --noEmit` (will fail until `agent.ts` is updated in Task 2.4 — that's expected; do Task 2.4 then typecheck).

### Task 2.4: Update the agent loop

**Files:**
- Modify: `agent/src/agent.ts`

- [ ] **Step 1: Replace `agent.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { readVaultState, submitExecute, isTargetAllowed, readPrice } from "./chain.js";
import { decide } from "./brain.js";
import { checkPolicy } from "./policy.js";
import { chain, aiVaultAddress, dexAddress } from "./config.js";

const client = new Anthropic();
const PRICE_HISTORY_MAX = 12;
const priceHistory: bigint[] = [];

async function tick(): Promise<void> {
  const price = await readPrice();
  priceHistory.push(price);
  if (priceHistory.length > PRICE_HISTORY_MAX) priceHistory.shift();

  const state = await readVaultState(aiVaultAddress);
  console.log("[state]", {
    mnt: state.balanceWei.toString(), token: state.tokenBalanceWei.toString(),
    price: state.priceWei.toString(), spentToday: state.spentToday.toString(), paused: state.paused,
  });
  if (state.paused) { console.log("[paused] skipping"); return; }

  const decision = await decide(client, state, priceHistory, dexAddress);
  console.log("[decision]", decision.kind, "-", decision.rationale);
  if (decision.kind === "hold") return;

  // Client-side guards mirroring the contract + DEX.
  const policy = checkPolicy(decision, state);
  if (!policy.ok) { console.log("[guard] blocked:", policy.reason); return; }
  if (!(await isTargetAllowed(aiVaultAddress, decision.target))) {
    console.log("[guard] target not allowlisted:", decision.target); return;
  }
  // Sell guard: don't sell more tokens than held (DEX would revert).
  if (decision.valueWei === 0n && state.tokenBalanceWei === 0n) {
    console.log("[guard] sell skipped: no token balance"); return;
  }

  const hash = await submitExecute(aiVaultAddress, decision);
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[executed]", `${base}/tx/${hash}`);
}

async function main() {
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? "60000");
  console.log("[agent] AI trader starting on", chain.name);
  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try { await tick(); } catch (e) { console.error("[tick error]", e); } finally { running = false; }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck + tests**: `cd agent && npx tsc --noEmit && npm test`
Expected: tsc clean; 13 tests pass (5 brain + 8 policy). (`AGENT_CONTEXT` env is no longer used — the agent now reasons over live price history; you may remove it from `.env.example`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/config.ts agent/src/chain.ts agent/src/agent.ts
git commit -m "feat(agent): trade loop over DEX with rolling price history + sell guard"
```

---

## Phase 3 — Price Keeper (Tier 2): simulate the market

**Goal:** a script that nudges `MockDEX.price` over time so the agent has a market to react to.

### Task 3.1: Keeper script

**Files:**
- Create: `agent/src/keeper.ts`
- Modify: `agent/package.json` (add a script)

- [ ] **Step 1: Create `agent/src/keeper.ts`**

```typescript
import { publicClient, walletClient, agentAccount, dexAddress } from "./config.js";
import { DEX_ABI } from "./dex.js";

// Random-walk the price within a band to simulate a market. Owner-only setPrice;
// for the demo the owner == the deployer; run this with the OWNER key (see note).
const STEP_BPS = 300; // ±3% per tick
const MIN = 1n * 10n ** 18n; // 1 MNT/token floor
const MAX = 5n * 10n ** 18n; // 5 MNT/token ceiling

async function setPrice(next: bigint) {
  const hash = await walletClient.writeContract({
    address: dexAddress, abi: DEX_ABI, functionName: "setPrice", args: [next], account: agentAccount,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function tick() {
  const cur = (await publicClient.readContract({ address: dexAddress, abi: DEX_ABI, functionName: "price" })) as bigint;
  // deterministic-ish jitter using block timestamp parity (no Math.random dependency requirement)
  const blk = await publicClient.getBlock();
  const up = (blk.timestamp % 2n) === 0n;
  const delta = (cur * BigInt(STEP_BPS)) / 10_000n;
  let next = up ? cur + delta : cur - delta;
  if (next < MIN) next = MIN;
  if (next > MAX) next = MAX;
  console.log("[keeper] price", cur.toString(), "->", next.toString());
  await setPrice(next);
}

async function main() {
  const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? "45000");
  console.log("[keeper] starting");
  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try { await tick(); } catch (e) { console.error("[keeper error]", e); } finally { running = false; }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> **Owner key note:** `setPrice` is `onlyOwner` (owner = deployer). For the demo, either (a) set `AGENT_PRIVATE_KEY` of the keeper run to the deployer key via a separate `.env`, or (b) add an `OWNER_PRIVATE_KEY` to config and a dedicated keeper wallet client. The simplest demo path: run the keeper in a shell where `AGENT_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY`. Document whichever you choose in the README.

- [ ] **Step 2: Add to `agent/package.json` scripts**:
```json
    "keeper": "tsx src/keeper.ts",
```

- [ ] **Step 3: Typecheck**: `cd agent && npx tsc --noEmit` (clean)

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/keeper.ts agent/package.json
git commit -m "feat(agent): price keeper simulating market movement"
```

---

## Phase 4 — PnL + Dashboard Overhaul (Tier 4 + Tier 2 #5)

**Goal:** measurable performance (portfolio value, ROI) reconstructed from on-chain events, plus a polished dashboard with charts, decision replay, live refresh, and dark mode.

### Task 4.1: Pure PnL helpers (TDD)

**Files:**
- Create: `agent/src/pnl.test.ts`
- Create: `agent/src/pnl.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { portfolioValueWei, roiBps } from "./pnl.js";

describe("portfolioValueWei", () => {
  it("sums MNT balance plus token value at price", () => {
    // 1 MNT + 0.5 token @ 2 MNT/token = 1 + 1 = 2 MNT
    expect(portfolioValueWei(1n * 10n ** 18n, 5n * 10n ** 17n, 2n * 10n ** 18n)).toBe(2n * 10n ** 18n);
  });
  it("is just MNT when no tokens", () => {
    expect(portfolioValueWei(3n * 10n ** 18n, 0n, 2n * 10n ** 18n)).toBe(3n * 10n ** 18n);
  });
});

describe("roiBps", () => {
  it("computes basis points gain", () => {
    // 1.1 vs 1.0 = +1000 bps
    expect(roiBps(11n * 10n ** 17n, 1n * 10n ** 18n)).toBe(1000n);
  });
  it("computes loss as negative bps", () => {
    expect(roiBps(9n * 10n ** 17n, 1n * 10n ** 18n)).toBe(-1000n);
  });
  it("returns 0 when start is 0", () => {
    expect(roiBps(5n, 0n)).toBe(0n);
  });
});
```

- [ ] **Step 2: Run, confirm RED**: `cd agent && npm test`

- [ ] **Step 3: Implement `pnl.ts`**

```typescript
/// Portfolio value in MNT wei: MNT balance + token value (tokenBalance * price / 1e18).
export function portfolioValueWei(mntWei: bigint, tokenWei: bigint, priceWei: bigint): bigint {
  return mntWei + (tokenWei * priceWei) / 10n ** 18n;
}

/// ROI in basis points vs a starting value. 0 if start is 0.
export function roiBps(current: bigint, start: bigint): bigint {
  if (start === 0n) return 0n;
  return ((current - start) * 10_000n) / start;
}
```

- [ ] **Step 4: Run, confirm GREEN**: `cd agent && npm test` (now 18 tests: 5 brain + 8 policy + 5 pnl). Commit:

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/pnl.ts agent/src/pnl.test.ts
git commit -m "feat(agent): PnL helpers (portfolio value, ROI bps) (TDD)"
```

### Task 4.2: Dashboard data layer — multi-vault logs + timeline reconstruction

**Files:**
- Modify: `web/lib/events.ts`
- Create: `web/lib/pnl.ts`
- Modify: `web/package.json` (add `recharts`)

- [ ] **Step 1: Add recharts to `web/package.json` dependencies**: `"recharts": "^2.12.0",`

- [ ] **Step 2: Replace `web/lib/events.ts`** (read AgentDecision per vault + DEX price/trade history)

```typescript
import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json";

const client = createPublicClient({ chain: mantleSepoliaTestnet, transport: http(process.env.MANTLE_RPC_URL) });
const FROM = BigInt(addresses.deployBlock ?? 0);

const DECISION = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);
const PRICE_SET = parseAbiItem("event PriceSet(uint256 price)");
const BOUGHT = parseAbiItem("event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price)");
const SOLD = parseAbiItem("event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price)");

export interface DecisionLog { nonce: string; target: string; value: string; rationale: string; txHash: string; block: string; }

export async function getDecisions(vault: `0x${string}`): Promise<DecisionLog[]> {
  const logs = await client.getLogs({ address: vault, event: DECISION, fromBlock: FROM });
  return logs.map((l) => ({
    nonce: l.args.nonce?.toString() ?? "",
    target: l.args.target ?? "",
    value: l.args.value?.toString() ?? "0",
    rationale: l.args.rationale ?? "",
    txHash: l.transactionHash ?? "",
    block: l.blockNumber?.toString() ?? "",
  })).reverse();
}

export interface PricePoint { block: bigint; price: bigint; }
export async function getPriceHistory(): Promise<PricePoint[]> {
  const logs = await client.getLogs({ address: addresses.mockDex as `0x${string}`, event: PRICE_SET, fromBlock: FROM });
  return logs.map((l) => ({ block: l.blockNumber ?? 0n, price: (l.args.price as bigint) ?? 0n }));
}

export interface Trade { who: string; block: bigint; side: "buy" | "sell"; mntWei: bigint; tokenWei: bigint; price: bigint; }
export async function getTrades(): Promise<Trade[]> {
  const dex = addresses.mockDex as `0x${string}`;
  const [buys, sells] = await Promise.all([
    client.getLogs({ address: dex, event: BOUGHT, fromBlock: FROM }),
    client.getLogs({ address: dex, event: SOLD, fromBlock: FROM }),
  ]);
  const trades: Trade[] = [
    ...buys.map((l) => ({ who: (l.args.who as string), block: l.blockNumber ?? 0n, side: "buy" as const, mntWei: (l.args.mntIn as bigint), tokenWei: (l.args.tokensOut as bigint), price: (l.args.price as bigint) })),
    ...sells.map((l) => ({ who: (l.args.who as string), block: l.blockNumber ?? 0n, side: "sell" as const, mntWei: (l.args.mntOut as bigint), tokenWei: (l.args.tokensIn as bigint), price: (l.args.price as bigint) })),
  ];
  return trades.sort((a, b) => (a.block < b.block ? -1 : 1));
}
```

- [ ] **Step 3: Create `web/lib/pnl.ts`** (reconstruct each vault's portfolio value over the price timeline)

```typescript
import type { PricePoint, Trade } from "./events";

// Token balance for a vault is the running sum of buys minus sells from the trade log.
// Portfolio value at a given price = (net MNT spent reconstructed from seed) — for the demo
// we track token balance over price points and value = tokenBalance * price (token leg),
// which is the comparable signal between AI and baseline.
export interface SeriesPoint { block: string; aiTokenValueWei: string; baselineTokenValueWei: string; priceWei: string; }

export function buildSeries(prices: PricePoint[], trades: Trade[], ai: string, baseline: string): SeriesPoint[] {
  let aiTok = 0n, blTok = 0n;
  let ti = 0;
  const out: SeriesPoint[] = [];
  for (const p of prices) {
    // apply all trades up to this block
    while (ti < trades.length && trades[ti].block <= p.block) {
      const t = trades[ti];
      const delta = t.side === "buy" ? t.tokenWei : -t.tokenWei;
      if (t.who.toLowerCase() === ai.toLowerCase()) aiTok += delta;
      else if (t.who.toLowerCase() === baseline.toLowerCase()) blTok += delta;
      ti++;
    }
    out.push({
      block: p.block.toString(),
      aiTokenValueWei: ((aiTok * p.price) / 10n ** 18n).toString(),
      baselineTokenValueWei: ((blTok * p.price) / 10n ** 18n).toString(),
      priceWei: p.price.toString(),
    });
  }
  return out;
}
```

- [ ] **Step 4: Install + commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon/web && npm install
cd /Users/gautam/Desktop/Turing-Hackathon
git add web/package.json web/package-lock.json web/lib/events.ts web/lib/pnl.ts
git commit -m "feat(web): multi-vault logs + PnL timeline reconstruction from chain events"
```

### Task 4.3: Dashboard UI — charts, dual-vault PnL, decision replay, dark mode, live refresh

**Files:**
- Modify: `web/app/page.tsx`
- Create: `web/app/components/PriceChart.tsx`
- Create: `web/app/components/DecisionFeed.tsx`

> UI is verified manually (visual), not unit-tested.

- [ ] **Step 1: Create `web/app/components/PriceChart.tsx`** (client component with recharts)

```tsx
"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";

export default function PriceChart({ data }: { data: any[] }) {
  const fmt = (w: string) => (Number(BigInt(w)) / 1e18).toFixed(4);
  const rows = data.map((d) => ({
    block: d.block,
    price: Number(BigInt(d.priceWei)) / 1e18,
    AI: Number(BigInt(d.aiTokenValueWei)) / 1e18,
    Baseline: Number(BigInt(d.baselineTokenValueWei)) / 1e18,
  }));
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="block" tick={{ fill: "#aaa", fontSize: 11 }} />
        <YAxis tick={{ fill: "#aaa", fontSize: 11 }} />
        <Tooltip contentStyle={{ background: "#111", border: "1px solid #333", color: "#eee" }} />
        <Legend />
        <Line type="monotone" dataKey="price" stroke="#888" dot={false} name="Price (MNT/token)" />
        <Line type="monotone" dataKey="AI" stroke="#4ade80" dot={false} name="AI token value" />
        <Line type="monotone" dataKey="Baseline" stroke="#60a5fa" dot={false} name="Baseline token value" />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Create `web/app/components/DecisionFeed.tsx`**

```tsx
import type { DecisionLog } from "../../lib/events";

export default function DecisionFeed({ title, decisions, explorer, accent }: {
  title: string; decisions: DecisionLog[]; explorer: string; accent: string;
}) {
  return (
    <div>
      <h2 style={{ color: accent }}>{title} — {decisions.length} decisions</h2>
      {decisions.map((d) => (
        <div key={d.nonce} style={{ border: "1px solid #2a2a2a", borderRadius: 12, padding: 14, marginBottom: 10, background: "#141414" }}>
          <div style={{ fontWeight: 600 }}>#{d.nonce} · {Number(BigInt(d.value)) / 1e18} MNT</div>
          <div style={{ marginTop: 6, fontStyle: "italic", color: "#cfcfcf" }}>“{d.rationale}”</div>
          <a href={`${explorer}/tx/${d.txHash}`} target="_blank" rel="noreferrer" style={{ color: accent, fontSize: 13 }}>tx ↗</a>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Replace `web/app/page.tsx`** (dark, auto-refreshing, dual feeds + chart)

```tsx
import { getDecisions, getPriceHistory, getTrades } from "../lib/events";
import { buildSeries } from "../lib/pnl";
import PriceChart from "./components/PriceChart";
import DecisionFeed from "./components/DecisionFeed";
import addresses from "../../shared/addresses.json";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const ai = addresses.aiVault as `0x${string}`;
  const baseline = addresses.baselineVault as `0x${string}`;
  const explorer = "https://explorer.sepolia.mantle.xyz";

  const [aiD, blD, prices, trades] = await Promise.all([
    getDecisions(ai), getDecisions(baseline), getPriceHistory(), getTrades(),
  ]);
  const series = buildSeries(prices, trades, ai, baseline);

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 1100, margin: "32px auto", padding: 16, background: "#0b0b0b", color: "#eee", minHeight: "100vh" }}>
      {/* Auto-refresh every 15s without client JS */}
      <meta httpEquiv="refresh" content="15" />
      <h1>🤖 Autonomous Agent Wallet — Human vs AI on Mantle</h1>
      <p style={{ color: "#999" }}>
        An AI agent (Claude) trades autonomously against a baseline DCA strategy. Every decision and trade is on-chain.
      </p>
      <section style={{ margin: "24px 0" }}>
        <PriceChart data={series} />
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <DecisionFeed title="🟢 AI agent" decisions={aiD} explorer={explorer} accent="#4ade80" />
        <DecisionFeed title="🔵 Human baseline (DCA)" decisions={blD} explorer={explorer} accent="#60a5fa" />
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Build**: `cd web && npm run build` (must succeed; placeholders won't break the dynamic page).

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add web/app/page.tsx web/app/components
git commit -m "feat(web): dark dashboard — price/PnL chart, dual AI-vs-baseline decision feeds, auto-refresh"
```

---

## Phase 5 — Human vs AI Baseline Runner (Tier 3 #3)

**Goal:** a deterministic DCA strategy driving the baseline vault, so the dashboard compares a dumb rule vs the AI.

### Task 5.1: Baseline DCA runner

**Files:**
- Create: `agent/src/baseline.ts`
- Modify: `agent/package.json` (script)

- [ ] **Step 1: Create `agent/src/baseline.ts`**

```typescript
import { parseEther } from "viem";
import { readVaultState, submitExecute, isTargetAllowed } from "./chain.js";
import { encodeBuy } from "./dex.js";
import { checkPolicy } from "./policy.js";
import { chain, baselineVaultAddress, dexAddress, baselineWalletClient } from "./config.js";
import type { Decision } from "./types.js";

// Dumb-but-honest human baseline: buy a fixed MNT amount every tick, regardless of price (DCA).
const DCA_MNT = "0.005";

async function tick(): Promise<void> {
  const state = await readVaultState(baselineVaultAddress);
  if (state.paused) return;

  const decision: Decision = {
    kind: "execute",
    target: dexAddress,
    valueWei: parseEther(DCA_MNT),
    calldata: encodeBuy(),
    rationale: `DCA: fixed ${DCA_MNT} MNT buy (human baseline)`,
  };

  const policy = checkPolicy(decision, state);
  if (!policy.ok) { console.log("[baseline] blocked:", policy.reason); return; }
  if (!(await isTargetAllowed(baselineVaultAddress, decision.target))) return;

  const hash = await submitExecute(baselineVaultAddress, decision, baselineWalletClient);
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[baseline executed]", `${base}/tx/${hash}`);
}

async function main() {
  const intervalMs = Number(process.env.BASELINE_INTERVAL_MS ?? "60000");
  console.log("[baseline] DCA runner starting on", chain.name);
  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try { await tick(); } catch (e) { console.error("[baseline error]", e); } finally { running = false; }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add script to `agent/package.json`**: `"baseline": "tsx src/baseline.ts",`

- [ ] **Step 3: Typecheck**: `cd agent && npx tsc --noEmit` (clean). Tests unchanged (18 pass).

- [ ] **Step 4: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/baseline.ts agent/package.json
git commit -m "feat(agent): deterministic DCA baseline runner for Human-vs-AI"
```

---

## Phase 6 — Circuit Breaker + Telegram Alerts (Tier 3 #6, #7)

**Goal:** auto-halt the AI on excessive drawdown (soft pause, no owner key needed) and broadcast each decision to Telegram.

### Task 6.1: Telegram alert helper (TDD the message formatting)

**Files:**
- Create: `agent/src/telegram.test.ts`
- Create: `agent/src/telegram.ts`

- [ ] **Step 1: Write the failing test** (we test the pure formatter; the send is env-gated and not unit-tested)

```typescript
import { describe, it, expect } from "vitest";
import { formatAlert } from "./telegram.js";

describe("formatAlert", () => {
  it("formats a trade alert", () => {
    const msg = formatAlert({ kind: "execute", valueWei: 10_000_000_000_000_000n, rationale: "price dipped 3%" } as any);
    expect(msg).toContain("0.01 MNT");
    expect(msg).toContain("price dipped 3%");
  });
  it("formats a hold", () => {
    expect(formatAlert({ kind: "hold", rationale: "waiting" } as any)).toContain("HOLD");
  });
});
```

- [ ] **Step 2: Run, confirm RED**: `cd agent && npm test`

- [ ] **Step 3: Implement `telegram.ts`**

```typescript
import type { Decision } from "./types.js";

export function formatAlert(d: Decision): string {
  if (d.kind === "hold") return `🤖 AI agent: HOLD — ${d.rationale}`;
  const mnt = Number(d.valueWei) / 1e18;
  const side = d.valueWei === 0n ? "SELL" : `BUY ${mnt} MNT`;
  return `🤖 AI agent: ${side} — ${d.rationale}`;
}

/// Fire-and-forget; no-op if Telegram env is not configured.
export async function sendAlert(d: Decision): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatAlert(d) }),
    });
  } catch (e) {
    console.error("[telegram] send failed", e);
  }
}
```

- [ ] **Step 4: Run, confirm GREEN**: `cd agent && npm test` (20 tests). 

### Task 6.2: Wire circuit breaker + alerts into the loop

**Files:**
- Modify: `agent/src/agent.ts`

- [ ] **Step 1: Add drawdown tracking + alert calls.** At the top of `agent.ts`, add imports and state:

```typescript
import { portfolioValueWei, roiBps } from "./pnl.js";
import { sendAlert } from "./telegram.js";
```
Add module state near `priceHistory`:
```typescript
let peakValueWei = 0n;
const MAX_DRAWDOWN_BPS = -1500n; // soft-pause if portfolio falls 15% below peak
let tripped = false;
```

- [ ] **Step 2: In `tick()`, after computing `state`, add the breaker check** (before deciding):

```typescript
  const value = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, state.priceWei);
  if (value > peakValueWei) peakValueWei = value;
  if (peakValueWei > 0n && roiBps(value, peakValueWei) <= MAX_DRAWDOWN_BPS) {
    if (!tripped) { tripped = true; console.warn("[breaker] drawdown limit hit — soft-pausing AI trading"); }
    return; // stop trading; the contract funds remain safe and owner can intervene
  }
```

- [ ] **Step 3: After a successful `submitExecute(...)`, send the alert.** Replace the executed log block with:

```typescript
  const hash = await submitExecute(aiVaultAddress, decision);
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[executed]", `${base}/tx/${hash}`);
  await sendAlert(decision);
```
And add a `sendAlert(decision)` call in the `hold` branch too (optional — comment it out if too chatty).

- [ ] **Step 4: Typecheck + tests**: `cd agent && npx tsc --noEmit && npm test` (20 pass, tsc clean)

- [ ] **Step 5: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add agent/src/telegram.ts agent/src/telegram.test.ts agent/src/agent.ts
git commit -m "feat(agent): drawdown circuit breaker (soft-pause) + Telegram decision alerts"
```

---

## Phase 7 — Tier 5 Roadmap (design only, not bite-sized tasks)

These are post-hackathon directions. They are documented here as design sketches, NOT decomposed into code steps, because each is a multi-week effort and writing "exact code" now would be speculative. Add a "Roadmap" section to the README summarizing them.

- [ ] **Step 1: Append a Roadmap section to `README.md`** describing:

1. **ERC-4337 account abstraction + scoped session keys.** Replace the custom `AgentVault` + EOA agent key with a smart account where the agent holds a *session key* whose permissions (target allowlist, value caps, expiry) are enforced by a session-key module/validator. Design: deploy a 4337 smart account (e.g. a Safe + session-key module or a Kernel/ZeroDev-style account); the agent signs UserOperations; a bundler submits them; the validator enforces the same limits the contract does today. Benefit: standards-based, gas abstraction, on-chain-verifiable scoped permissions. Risk: bundler/infra dependency, larger surface — hence post-hackathon.
2. **Real Mantle DeFi protocol swap-in.** Replace `MockDEX` with a live Mantle DEX/lending market: add its router as an allowlisted target and encode real swap calldata in `dex.ts`. The vault, guards, decision log, and dashboard are unchanged — only the target + calldata differ. Requires verifying the protocol is deployed on the target network and handling real slippage/approvals.
3. **Multi-agent leaderboard.** Index `AgentDecision` + DEX trade logs across many vaults into a ranked board by realized ROI — the literal "benchmark" product. Backend: a small indexer (Ponder/Subsquid) feeding a ranked view.
4. **Strategy marketplace.** Let users register strategy modules (each a contract or signed policy) the agent can select between, scored by on-chain outcomes; revenue-share to strategy authors.
5. **Mainnet hardening.** Timelocked owner, multisig, conservative limits, monitoring/alerting, audit, and rate-limit/anomaly detection beyond the soft breaker.

- [ ] **Step 2: Commit**

```bash
cd /Users/gautam/Desktop/Turing-Hackathon
git add README.md
git commit -m "docs: add Tier 5 roadmap (4337 session keys, real protocol, leaderboard, marketplace, mainnet)"
```

---

## Self-Review (run against the spec)

**Tier coverage:**
- Tier 1 (#1 real action) → Phases 1–2: MockDEX + buy/sell/hold trading. ✓
- Tier 2 (#2 data-driven) → Phase 2 price history in context + Phase 3 keeper. ✓
- Tier 2 (#5 replay) → Phase 4 decision feeds + price/PnL chart from on-chain logs. ✓
- Tier 3 (#3 Human vs AI) → Phase 5 baseline DCA vault + dashboard comparison. ✓
- Tier 3 (#6 breaker, #7 Telegram) → Phase 6. ✓
- Tier 4 (#4 PnL, #8 polish) → Phase 4 pnl helpers + dark/charts/auto-refresh dashboard. ✓
- Tier 5 → Phase 7 roadmap (design only, as stated up front). ✓

**Type/interface consistency:**
- `Decision` shape unchanged (`hold | execute{target,valueWei,calldata,rationale}`); `parseToolUse(input, dex)` now takes the DEX address; `decide(client, state, priceHistory, dex)` signature updated and matched in `agent.ts`. ✓
- `VaultState` gains `tokenBalanceWei`, `priceWei`; produced in `chain.ts readVaultState` and consumed in `brain.ts decide` and `agent.ts` breaker. ✓
- `MockDEX` event names (`PriceSet`, `Bought`, `Sold`) match the `parseAbiItem` strings in `web/lib/events.ts`; `AgentDecision` matches the existing contract. ✓
- `DEX_ABI` (`price`, `tokenBalance(address)`, `buy()` payable, `sell(uint256)`, `setPrice(uint256)`) matches `MockDEX.sol`. ✓
- `submitExecute(vault, decision, client)` signature updated; called with the AI wallet in `agent.ts` and the baseline wallet in `baseline.ts`. ✓
- `addresses.json` keys (`mockDex`, `aiVault`, `baselineVault`, `deployBlock`) match all consumers (config.ts, events.ts, page.tsx, pnl reconstruction). ✓

**Known external prerequisites (handled, not placeholders):**
- Three funded testnet keys (deployer/owner, AI agent, baseline agent) — documented in `.env.example` updates (Task 1.3) and deploy (Phase 1). The keeper's owner-key requirement is called out with two concrete options.
- `setPaused`/`setPrice` are owner-only — the plan uses a soft-pause breaker (no owner key in the agent) and documents the keeper owner-key options, avoiding an unsolved permission gap.
- `recharts` is the only new dependency; added in Task 4.2.

**Decomposition note:** Phases 1–6 each produce a working, demoable increment. If you prefer, Phases 4 (dashboard) and 5–6 (baseline + safety) can be split into separate execution sessions — each is independent given Phases 1–3.
```
