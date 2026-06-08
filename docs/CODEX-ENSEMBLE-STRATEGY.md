# Codex Brief — Regime-Routed Ensemble Strategy (beat the momentum comparator)

**Audience:** Codex (autonomous coding agent).
**Author:** Claude (review, 2026-06-07).
**Repo:** `/Users/gautam/Desktop/Turing-Hackathon` — branch `master`.

This is the one remaining recommended improvement. Everything else (on-chain guard, oracle-bound `minOut`, CI, web rigor, threat model) is done and green. The open gap is **strategy performance**: the AI does not yet beat the momentum baseline.

**This is a research task with an honest acceptance gate. Do not claim success unless the numbers clear the gate. If they don't, ship it behind a flag and document the negative result — that is an acceptable, expected outcome.** Money/eval code is TDD where it has pure logic. Don't break the 189 existing tests. Commit after each green step.

---

## 0. The exact problem (measured, from `docs/reports/2026-06-07-regime-aware-agent-upgrade.md`)

On 100 seeded, no-lookahead held-out paths (seed `20260607`, 14 ticks, 30 bps fee + 20 bps slippage + 0.0002 MNT gas), average net return:

| Strategy | Avg net return | Regime policy win rate vs it |
|---|---:|---:|
| Momentum | **+17 bps** | regime beats it only **46 / 100** |
| Regime-aware deterministic policy (current) | +15 bps | — |
| Always hold | 0 bps | 27 / 100 |
| Mean reversion | -24 bps | 61 / 100 |
| DCA | -48 bps | 67 / 100 |

**Diagnosis (already established in the report):** the current regime policy is *too timid in confirmed uptrends* — in `trend_up` it only adds ~25 bps of baseline and sells too early, leaving most trend upside to the momentum comparator. Its positive average is concentrated in a few range/shock paths. It already beats DCA and mean-reversion; **the single thing it must fix is matching/beating momentum in persistent trends without giving back its range/shock edge.**

That is exactly what a **regime-routed ensemble** is for: in confirmed trends, behave like momentum; in ranges, behave like mean-reversion; in shocks, manage risk.

---

## 1. Goal & acceptance gate (hard, measurable — do not move the goalposts)

Implement a deterministic **regime-routed ensemble** strategy and evaluate it with the existing held-out harness.

**Acceptance gate — ALL must hold to merge it onto the default decision path:**
1. On the **100 held-out paths** (seed `20260607`, default config), the ensemble's **average net ROI ≥ momentum AND ≥ DCA AND ≥ mean-reversion AND ≥ hold**.
2. **Per-path win rate vs momentum ≥ 55/100** (not just average — avoid a few lucky paths).
3. **Worst-drawdown not materially worse** than the current regime policy (within ~10%).
4. **No safety regression:** all forge + agent tests still pass; risk/simulation/guard paths unchanged.
5. **Robustness:** re-run the held-out generation+eval with **two additional seeds** (e.g. `20260608`, `99999999`) and confirm the ensemble still beats momentum on average on both. (Generate fresh fixtures per seed; do not reuse.)

**Anti-overfitting rules (mandatory):**
- **Tune only on the 20 development paths** (`market-paths-development.json`). Treat the 100 held-out paths as a write-once test set — look at them at most a few times, never tune thresholds to them.
- Do **not** tune to the 4 hand-authored regime fixtures.
- If the gate fails after reasonable effort, **do not merge to default**. Keep the ensemble selectable behind an env flag / option, and write an honest report with the numbers (including where it loses). A truthful negative result is the required deliverable in that case.

---

## 2. Design

### 2.1 Shared strategy interface (new)
Today the offline eval (`createOfflineBenchmarkDecisionRunner`, `multiRegimeEval.ts:605-678`) and the live agent (`brain.ts`) have **separate** decision logic. Create one shared, pure, deterministic strategy module so the same logic is evaluated offline and (optionally) used live.

Create `agent/src/strategies/ensemble.ts`:
```typescript
import type { MarketFeatures } from "../marketFeatures.js";
import type { VaultState } from "../types.js";

export interface StrategyInput {
  priceHistory: readonly bigint[];
  features: MarketFeatures;   // from computeMarketFeatures(priceHistory)
  state: VaultState;          // balanceWei, tokenBalanceWei, priceWei, limits...
  baselineBuyWei: bigint;     // the DCA unit, for sizing reference
}

export interface StrategyIntent {
  action: "buy" | "sell" | "hold";
  amountMntWei?: bigint;      // buy
  amountTokenWei?: bigint;    // sell
  sizePercent: number;        // 0-100, for trace/analysis parity with the model path
  expectedEdgeBps: number;
  rationale: string;
}

export type StrategyFunction = (input: StrategyInput) => StrategyIntent;
```

### 2.2 The ensemble (route on `features.regime`)
`computeMarketFeatures` (`marketFeatures.ts:5-17`, `computeMarketFeatures(priceHistory)`) already returns `regime ∈ {trend_up, trend_down, range, shock, uncertain}` plus `confidence`, `shortSlopeBps`, `longSlopeBps`, `momentumBps`, `volatilityBps`, `drawdownFromPeakBps`, `latestReturnBps`, `consecutiveUp/Down`. Route:

- **`trend_up` (the fix):** behave like a **momentum trend-follower** — buy a *meaningful* size (e.g. scale 30–80% of remaining per-tx/daily capacity with `confidence`), and **do NOT sell** while the uptrend and streak persist. This is the change that recovers the trend upside currently lost to momentum. Only exit when regime flips (trend breaks / `drawdownFromPeakBps` crosses a threshold).
- **`trend_down`:** preserve capital — **do not buy dips**; optionally trim inventory (small sell) or hold. (Current behavior is roughly right here.)
- **`range`:** **mean-reversion** — buy when price is meaningfully below the recent average, sell a fraction when meaningfully above. (This is where the policy already earns; keep it.)
- **`shock`:** risk-off — hold through the shock tick; allow a *small* recovery buy only once a recovery signal appears (positive `latestReturnBps` after the shock), sized conservatively.
- **`uncertain`:** hold.

Gate every non-hold action by an **edge-vs-cost check**: only act if `expectedEdgeBps > estimatedExecutionCostBps + buffer` (mirror `applyDecisionPolicy` in `brain.ts:234-302`; reuse its constants). Compute a plausible `expectedEdgeBps` per regime from the slopes (e.g. for `trend_up` use `shortSlopeBps`; for `range` use distance-from-mean in bps).

Keep all sizing within the existing per-tx / daily / balance caps (the eval and live paths already clamp; your intent just proposes).

### 2.3 Calibratable thresholds (tune on dev set only)
Expose the knobs (trend-buy aggression, uptrend no-sell band, range buy/sell bands, shock recovery size, min edge buffer, confidence floor) as named constants at the top of `ensemble.ts`. **Tune them against the 20 development paths only.**

---

## 3. Integration points (exact files)

1. **New:** `agent/src/strategies/ensemble.ts` (above) + `agent/src/strategies/ensemble.test.ts`.
2. **Offline eval seam — `multiRegimeEval.ts:605-678`:** refactor `createOfflineBenchmarkDecisionRunner()` to call the shared `regimeRoutedEnsemble(strategyInput)` instead of its current inline regime logic, then convert the returned `StrategyIntent` → `Decision` using the existing intent→plan→decision path (same conversion the inline logic uses today). Keep the comparator strategies (`buildComparatorDecision`, `multiRegimeEval.ts:425-485` — `dca`/`momentum`/`mean-reversion`/`hold`) UNCHANGED — they are the yardstick.
3. **Live path (optional, gated):** in `brain.ts` `decide(...)` / `DecisionOptions`, add an optional `strategyPrior?: StrategyFunction`. When set (e.g. via `AGENT_STRATEGY=ensemble`), use the ensemble's regime+sizing as a deterministic prior/clamp on the model proposal (NOT a replacement — the model still explains; the deterministic policy in `applyDecisionPolicy` still applies). Do not wire this on by default unless the gate passes.

Keep the model's structured output and `applyDecisionPolicy` intact — the ensemble is a sizing/routing layer, not a removal of the safety policy.

---

## 4. Tests (TDD)

`agent/src/strategies/ensemble.test.ts` — pure, deterministic, no network:
- `trend_up + high confidence` → action `buy`, size clearly larger than the current 25-bps-of-baseline (assert `amountMntWei` ≥ a threshold), and **no sell**.
- `trend_up` with rising streak → never returns `sell`.
- `trend_down` → never returns `buy` (no dip-buying); returns `hold` or `sell`.
- `range`, price below recent avg → `buy`; above avg → `sell`; near avg → `hold`.
- `shock` at the crash tick → `hold`; post-shock recovery signal → small `buy`.
- edge-below-cost → downgraded to `hold`.
- Construct `MarketFeatures` inputs directly (don't depend on the live model).

Keep existing eval tests passing; if you refactor the offline runner, update its unit test to assert it now delegates to the ensemble.

---

## 5. Evaluation protocol (run exactly this; record results honestly)

```bash
cd agent

# 1) Tune on DEV ONLY (iterate thresholds against these 20 paths):
npm run eval:generate-heldout -- --seed=20260607 --dev=20 --test=100 --ticks=14 evals/generated
npm run eval:multi-regime:offline -- evals/generated/market-paths-development.json traces/dev.json --summary

# 2) ONE held-out evaluation (do not tune after seeing this):
npm run eval:multi-regime:offline -- evals/generated/market-paths-held-out.json traces/heldout-test.json --summary

# 3) Robustness — two more seeds, fresh fixtures each:
npm run eval:generate-heldout -- --seed=20260608 --dev=20 --test=100 --ticks=14 evals/generated-2
npm run eval:multi-regime:offline -- evals/generated-2/market-paths-held-out.json traces/heldout-2.json --summary
npm run eval:generate-heldout -- --seed=99999999 --dev=20 --test=100 --ticks=14 evals/generated-3
npm run eval:multi-regime:offline -- evals/generated-3/market-paths-held-out.json traces/heldout-3.json --summary
```
Read `aggregate.comparatorAverageNetRoiBps` and `aggregate.aiWinsByComparator` from each output JSON. The ensemble runs as the "ai" path in offline mode, so compare `aiAverageNetRoiBps` and `aiWinsByComparator.momentum` against the gate.

(Optional, costly) A small **live-model** confirmation once offline passes: `npm run eval:multi-regime -- --summary` — but the offline deterministic gate is the primary acceptance signal; do not spend large API budget.

---

## 6. Deliverables / definition of done

- `agent/src/strategies/ensemble.ts` + tests (green).
- Offline eval refactored to use the shared ensemble; comparators unchanged.
- A report `docs/reports/2026-06-07-ensemble-strategy.md` with: the design, the dev-set tuning summary, the held-out numbers for all 3 seeds (ensemble vs dca/momentum/mean-reversion/hold: avg net ROI + win-rate vs momentum + worst drawdown), and a clear **PASS/FAIL against the §1 gate**.
- **If PASS:** wire the ensemble onto the default offline path, update the README "Multi-Regime Generalization" section with the new honest numbers, and (optionally) enable the live `strategyPrior` behind `AGENT_STRATEGY=ensemble`.
- **If FAIL:** keep it behind a flag, and the report states plainly that momentum still wins and why — do not change the README to claim a win.
- All 189 existing tests + new tests pass; `tsc --noEmit` clean; CI green.

## 7. Conventions
- Deterministic, no-lookahead: the strategy may only use `priceHistory` up to the current tick (already enforced by the harness — never read future prices).
- No `Math.random` in the strategy itself (the fixtures provide the randomness, seeded).
- Reuse `applyDecisionPolicy` constants for the edge/confidence/cost gates rather than inventing parallel ones.
- TDD for the strategy logic; commit after each green step with clear messages.

## 8. Why this matters (scoring)
This is the last open item. If it clears the gate, **Strategy performance moves 6.5 → ~8.0** and the composite goes from ~9.0 to ~9.2–9.3, with the headline claim ("the AI out-risk-manages and out-performs a deterministic baseline") finally backed by held-out evidence. If it fails, the honest negative result still strengthens credibility — judges trust a benchmark that can report a loss.
