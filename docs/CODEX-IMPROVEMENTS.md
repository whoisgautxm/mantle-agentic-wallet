# Improvement Brief for Codex — Mantle Autonomous Agent Wallet

**Audience:** Codex (autonomous coding agent) implementing the next slice of this project.
**Author:** Claude (architecture review, 2026-06-07).
**Repo:** `/Users/gautam/Desktop/Turing-Hackathon` — branch `master`.

This document is a complete, actionable spec. It contains (1) the analysis of the current state, (2) the prioritized improvements with concrete designs, file paths, and acceptance criteria, and (3) the verification commands. Implement the items in priority order. **Each money-handling change is TDD: write the failing test first, then the code.** Do not break existing tests (174 total: 148 agent vitest + 26 forge). Commit after each green item.

---

## 0. Current State (context)

The project is an AI-controlled smart-contract wallet on Mantle Sepolia that trades against a self-contained `MockDEX`, competes against a deterministic DCA "human baseline," and records every decision on-chain. It already has: a TypeScript risk engine, Pyth oracle reads, Merchant Moe adapters with mainnet-fork tests, a pre-trade simulation gate, ERC20 allowance tracking, four eval harnesses, regime classification, a demo orchestrator, and a deployed dashboard. Tests: **148 agent + 26 contract, all passing**; OpenAI replay eval 82/100.

Key files:
- Contracts: `contracts/src/AgentVault.sol`, `contracts/src/MockDEX.sol`, `contracts/script/Deploy.s.sol`
- Agent loop: `agent/src/agent.ts`; risk: `agent/src/risk/engine.ts`, `agent/src/risk/limits.ts`; execution protection: `agent/src/protocols/executionProtection.ts`; simulation: `agent/src/simulation/`; oracles: `agent/src/oracles/`
- Web: `web/app/page.tsx`, `web/lib/*`
- Deployed addresses: `shared/addresses.json`

---

## 1. THE CORE FINDING — read before doing anything

The project's thesis (README) is: *"the model proposes high-level intent only … the Solidity vault remains the source of truth … bounded, simulated, protocol-aware execution without giving the model arbitrary control over user funds."*

**This is not actually true today.** `AgentVault.execute()` (`contracts/src/AgentVault.sol:86-105`) enforces only four things on-chain:
```solidity
require(!paused, "paused");
require(allowedTarget[target], "target not allowed");
require(value <= spendLimitPerTx, "over per-tx limit");
require(spentToday + value <= dailyLimit, "over daily limit");
// then: target.call{value: value}(data)  <-- arbitrary calldata, no output check
```
Every advanced guard — **oracle-deviation** (`risk/engine.ts:89`), **slippage/min-output** (`protocols/executionProtection.ts:42`), **simulation gate** (`simulation/`), **position/trade-value limits**, **allowance bounds** — is **TypeScript-only and advisory**. The contract never checks what a swap *returns*; it only caps the MNT *sent*.

**Impact:** a compromised agent key (or any off-chain-guard bug) can call an allowlisted DEX/router with `minOut = 0`, get sandwiched / swap at a terrible rate, and bleed funds up to the per-tx/daily caps — with **zero on-chain slippage protection**. The contract caps the *rate* of loss, not the *quality* of each trade.

Compounding this: **`MockDEX.buy()` / `sell()` have no `minOut` parameter at all** (`contracts/src/MockDEX.sol:37,46`), so even the off-chain `minOutWei` that `executionProtection.ts` computes cannot be enforced on the MockDEX path.

**Closing this gap is Improvement #1 and the single highest-value change.** It converts the headline claim from aspirational to true.

---

## 2. Scorecard (why this work matters)

| Dimension (weight) | Now | Target after | Driver |
|---|:--:|:--:|---|
| Concept / on-theme (15%) | 9.5 | 9.5 | — |
| Technical depth (20%) | 9.0 | 9.5 | #1 on-chain guard |
| **Safety integrity (20%)** | **6.0** | **9.0** | #1 + #2 |
| Strategy performance (10%) | 6.0 | 7.0 | #5 (uncertain) |
| Eng. rigor: CI/lint/repro (10%) | 7.0 | 8.7 | #3 + #4 |
| Demo / UX (15%) | 8.5 | 9.0 | #2 red-team demo |
| Docs / credibility (10%) | 8.0 | 9.0 | #2 threat model |
| **Composite** | **≈ 7.8 / 10** | **≈ 8.9 / 10** | |

---

## 3. Improvements (priority order)

### IMPROVEMENT #1 — Move trade safety on-chain: `executeGuarded` with min-output (FLAGSHIP)

**Goal:** the vault contract itself must reject a swap that returns less than a caller-supplied minimum output. After this, a compromised agent key cannot execute a bad-price swap — the contract enforces it.

**Design.** Add a guarded execution path to `AgentVault.sol` that measures the vault's output-asset balance delta across the external call and enforces a floor:

```solidity
// new errors/events
error InsufficientOutput(uint256 received, uint256 minOut);
event AgentGuardedDecision(
    uint256 indexed nonce, address indexed target, uint256 value,
    address outAsset, uint256 minOut, uint256 received, bytes data, string rationale
);

/// @notice Execute an allowlisted call and require it delivers >= minOut of outAsset to this vault.
/// @param outAsset address(0) => native MNT balance delta; otherwise an ERC20 measured via balanceOf.
function executeGuarded(
    address target,
    uint256 value,
    bytes calldata data,
    address outAsset,
    uint256 minOut,
    string calldata rationale
) external onlyAgent returns (bytes memory) {
    require(!paused, "paused");
    require(allowedTarget[target], "target not allowed");
    require(value <= spendLimitPerTx, "over per-tx limit");
    _rollWindow();
    require(spentToday + value <= dailyLimit, "over daily limit");
    spentToday += value;

    uint256 beforeBal = _assetBalance(outAsset); // see note on native delta below
    (bool ok, bytes memory ret) = target.call{value: value}(data);
    require(ok, "call failed");
    uint256 received = _assetBalance(outAsset) - beforeBal; // for native, add back `value` spent — see note
    if (received < minOut) revert InsufficientOutput(received, minOut);

    emit AgentGuardedDecision(nonce, target, value, outAsset, minOut, received, data, rationale);
    nonce += 1;
    return ret;
}
```

**Native-MNT subtlety (sells):** when `outAsset == address(0)` and `value > 0`, the contract's own balance both decreases by `value` (sent) and increases by what the swap returns. Measure correctly: `received = (afterNativeBal + value) - beforeNativeBal` for native, OR — simpler and recommended — **only support `outAsset != address(0)` (ERC20) for `executeGuarded` swaps**, and keep native-MNT-returning sells on a separate guarded path that checks `address(this).balance` increase with `value == 0` (sells send 0 MNT). Choose the cleaner option and document it; add tests for whichever path(s) you support.

**MockDEX alignment (required so the guard is demonstrable end-to-end).** MockDEX currently credits an *internal ledger* (`tokenBalance[msg.sender]`), not an ERC20 the vault holds, so a generic ERC20 balance-delta guard cannot measure a MockDEX buy. Fix by EITHER:
- **(Recommended) Upgrade MockDEX to deliver a real ERC20.** Add a minimal `MockToken is ERC20` (or a self-contained ERC20 in MockDEX). On `buy`, mint/transfer `tokensOut` to `msg.sender`; on `sell`, pull tokens via `transferFrom` (vault approves first through `executeGuarded` to the token, or use an internal `sellFor`). This makes MockDEX behave like a real protocol (ERC20 out), so one `executeGuarded` path covers MockDEX **and** Merchant Moe. Update `MockDEX.t.sol`, `mockDexAdapter.ts`, `chain.ts` token reads, and `web/lib/events.ts`/`pnl.ts` (token balance now read from the ERC20, not the DEX ledger).
- **(Alternative, less clean)** Add `minOut` params directly to MockDEX (`buy(uint256 minTokensOut)`, `sell(uint256 amount, uint256 minMntOut)`) and have MockDEX enforce them. This protects the MockDEX path but does NOT give you a *generic vault-level* guard for real protocols. Prefer the ERC20 upgrade.

**Agent wiring.** In `agent/src/agent.ts` and the adapters, route trades through `executeGuarded`, passing `minOut = executionProtection.minOutWei` (already computed in `protocols/executionProtection.ts:42`). Add `executeGuarded` to the vault ABI in `agent/src/vault.ts`. The off-chain risk engine stays as a pre-flight, but the on-chain floor is now authoritative.

**Tests (TDD — `contracts/test/AgentVault.t.sol`, add a guarded-swap mock target):**
- `test_executeGuarded_succeedsWhenOutputMeetsMin` — swap returns >= minOut → success, `AgentGuardedDecision` emitted with correct `received`.
- `test_executeGuarded_revertsWhenOutputBelowMin` — malicious/low-output target → reverts `InsufficientOutput`.
- `test_executeGuarded_stillEnforcesPerTxAndDailyAndPauseAndAllowlist` — all existing guards still apply.
- `test_executeGuarded_reentrancyBlocked` — reuse the existing reentrancy mock pattern.
- ERC20 path: a `MockMaliciousTarget` that takes `value` and delivers fewer tokens than `minOut`.

**Definition of done:** `forge test` green (existing 26 + new); agent routes real/Mock swaps through `executeGuarded`; `agent npm test` + `npx tsc --noEmit` green; `web build` green. A swap that violates `minOut` reverts **on-chain** (proven by a forge test).

---

### IMPROVEMENT #2 — Red-team proof + threat-model doc + adversarial review

**Goal:** turn the (now-closed) enforcement boundary into a credibility asset.

1. **Red-team script/test** (`agent/src/redteam.ts` + `agent/src/redteam.test.ts`, or a forge test): simulate a *malicious agent* that bypasses every TypeScript guard and submits a zero-`minOut` / bad-price swap directly via `executeGuarded`. Assert the **contract** reverts (`InsufficientOutput`) and funds are preserved. This is the "you cannot drain it" demo.
2. **`SECURITY.md`** at repo root: a concise threat model table — for each protection (pause, allowlist, per-tx, daily, **min-output**, oracle-deviation, simulation, allowance), state *enforced on-chain* vs *advisory off-chain*, and the failure it prevents. Be honest: after #1, min-output is on-chain; oracle-deviation/simulation remain advisory pre-flights (note this).
3. **Run `/codex:adversarial-review --base master`** (or your equivalent) on the contract changes and record the output under `docs/reports/2026-06-07-security-review.md`. Address any real findings.

**Definition of done:** red-team test passes (malicious swap reverted on-chain); `SECURITY.md` committed; security-review report committed with findings addressed.

---

### IMPROVEMENT #3 — CI pipeline (GitHub Actions)

**Goal:** automated quality gate. There is **no CI today**.

Create `.github/workflows/ci.yml` that, on push and PR to `master`:
- **contracts job:** install Foundry (`foundry-rs/foundry-toolchain`), `cd contracts && forge test -vvv`.
- **agent job:** Node 22, `cd agent && npm ci && npm test && npx tsc --noEmit`.
- **web job:** Node 22, `cd web && npm ci && npm run build`.
- Skip the Merchant Moe **fork** tests in CI (they require an Anvil mainnet fork / RPC) — confirm they already skip gracefully without `MERCHANT_MOE_*` env, or guard them behind an env flag so CI is green without secrets.

Add a CI status badge to `README.md`.

**Definition of done:** workflow file committed; all three jobs pass on a test push; badge added.

---

### IMPROVEMENT #4 — Tighten web + repo rigor

- `web/tsconfig.json`: set `"strict": true` and fix any resulting type errors (currently `strict:false`).
- Add a `web` test script + a couple of unit tests for `web/lib/pnl.ts` (`buildSeries`, `currentStanding`) — pure functions, easy to test, and they drive the headline scoreboard.
- Add minimal **ESLint + Prettier** configs at repo root (or per-package) and a `lint` script; wire `lint` into CI (#3).
- Resolve or pin the Recharts 2 build deprecation warning noted in the submission report.

**Definition of done:** `cd web && npx tsc --noEmit` passes under strict; `web` test script runs ≥2 passing tests; `lint` script exists and passes in CI.

---

### IMPROVEMENT #5 — Strategy: stop losing to momentum (ATTEMPT, not a promise)

**Context:** the honest multi-regime benchmark shows the AI still trails momentum (regime policy +15 bps vs momentum +17 bps on 100 held-out paths) and bleeds in persistent trends (`docs/reports/2026-06-07-multi-regime-benchmark.md`).

**Different approach (not another prompt tweak): a regime-routed ensemble.** Use the existing deterministic regime classifier (`agent/src/marketFeatures.ts`) to *route* between sub-strategies instead of relying on one mean-reversion prompt:
- Confirmed uptrend → momentum/trend-following sizing (ride it, don't sell early).
- Confirmed range → mean-reversion (current behavior).
- Shock/high-vol → reduce size or hold.

Implement as a deterministic policy layer that can override/clamp the LLM proposal (the LLM still explains; the router enforces regime-appropriate sizing). Evaluate with the **existing held-out harness** (`npm run eval:generate-heldout` + `eval:multi-regime:offline`).

**Acceptance gate (do not merge otherwise):** the ensemble must (a) beat DCA, mean-reversion, **and** momentum on average across the 100 untouched held-out paths, and (b) not weaken any safety test. If it fails to beat momentum, keep it behind a flag and document the negative result honestly (matching the project's existing discipline). **Do not tune thresholds to the 4 tracked fixtures.**

**Definition of done:** ensemble implemented + tested; held-out eval numbers recorded in a new report; merged to default path only if it clears the acceptance gate, else flagged + documented.

---

## 4. Conventions & constraints

- **TDD for all money-handling code** (`AgentVault.sol`, `MockDEX.sol`, `policy.ts`, risk, guard): failing test first.
- **Never hardcode keys.** Read from env. `.env` is gitignored.
- **The contract is the source of truth.** Off-chain checks are pre-flights; do not weaken on-chain checks to make a test pass.
- **Don't break existing tests.** Run the full suite before each commit.
- Keep files small and focused; match existing style.
- Commit after each green improvement with a clear message (e.g., `feat(contracts): on-chain min-output guard (executeGuarded)`).
- If a deployed-address change is needed (e.g., MockDEX ERC20 upgrade), redeploy via `contracts/script/Deploy.s.sol`, update `shared/addresses.json` (incl. `deployBlock`), and verify the dashboard still reconstructs.

## 5. Verification commands

```bash
# contracts
cd contracts && forge test -vvv

# agent
cd agent && npm test && npx tsc --noEmit

# web
cd web && npm run build

# evals (strategy work)
cd agent && npm run eval:generate-heldout && npm run eval:multi-regime:offline
```

## 6. Suggested order of execution

1. **#1 on-chain `executeGuarded` + min-output** (contracts + MockDEX ERC20 upgrade + agent wiring + tests) — flagship.
2. **#2 red-team test + `SECURITY.md` + adversarial review.**
3. **#3 CI.**
4. **#4 web strict + lint + web tests.**
5. **#5 ensemble strategy** (attempt; gated on held-out results).

Each item is independently shippable and raises the score. #1 is the one that matters most — it makes the project's central safety claim actually true on-chain.
