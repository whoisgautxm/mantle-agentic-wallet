# Recovery-State Probe + Multi-Seed Held-Out Evaluation

Date: June 7, 2026
Scope: P1 recovery-state machine, and an honest multi-seed held-out benchmark of the current regime-routed ensemble vs DCA / momentum / mean-reversion / hold.

## Method

- Deterministic, no-lookahead held-out fixtures (`heldOutMarketFixtures.ts`), 100 test paths × 14 ticks per seed.
- Offline deterministic decision path (`eval:multi-regime:offline`), so AI and comparators face identical paths.
- Costs per execution: 30 bps fee + 20 bps slippage + 0.0002 MNT gas.
- Seeds: `20260607`, `20260608`, `99999999`.

## Result 1 — the recovery probe is a no-op on this benchmark (kept OFF)

With `ENSEMBLE_RECOVERY_PROBE=0` (default) vs `=1`, the held-out aggregate was **byte-identical** (seed `20260607`: AI `+63 bps`, wins `dca 94 / momentum 58 / mean-reversion 74 / hold 27`, unchanged either way).

Why: the recovery-state probe is placed in the ensemble's `uncertain` fallthrough, but recovery-shaped paths classify as `range` or `trend` (and are handled there) **before** reaching that branch, so the probe almost never fires on these synthetic paths. The deterministic FSM itself is correct and unit-tested (`recoveryState.test.ts`), but as wired it does not move the held-out numbers.

**Decision (per our acceptance discipline): keep the recovery probe OFF by default.** It did not clear the bar (no measurable improvement). A future experiment could evaluate detecting recovery *ahead of* the range branch — but only if it improves held-out results without weakening safety. We do not claim it as an improvement now.

## Result 2 — the current ensemble already beats the comparators (the real finding)

Average net return (bps) over 100 held-out paths per seed:

| Seed | AI ensemble | DCA | Momentum | Mean-reversion | Hold |
|---|---:|---:|---:|---:|---:|
| 20260607 | **+63** | -48 | +17 | -24 | 0 |
| 20260608 | **+57** | -72 | +23 | -18 | 0 |
| 99999999 | **+66** | -50 | +25 | -21 | 0 |

Per-path win rate (of 100):

| Seed | vs DCA | vs Momentum | vs Mean-reversion | vs Hold |
|---|---:|---:|---:|---:|
| 20260607 | 94 | 58 | 74 | 27 |
| 20260608 | 92 | 44 | 63 | 24 |
| 99999999 | 93 | 49 | 70 | 27 |

## Honest interpretation

- **vs the DCA "human" baseline: decisive.** The AI wins on average by ~110–130 bps and on **92–94 of 100 paths** across every seed. This is the core Turing-Test claim and it is robustly supported.
- **vs momentum: wins on average net return on all three seeds** (+57…+66 vs +17…+25), but the **per-path win rate is ~44–58%** — roughly even. The AI's edge over momentum comes from *larger* wins (better risk-managed entries/exits), not from winning more often. We do not claim "beats momentum on most paths."
- **vs hold:** hold wins more individual paths (the AI trades and pays costs on flat paths), but the AI's average return is far higher, and hold captures no upside.

This supersedes the earlier `2026-06-07-regime-aware-agent-upgrade.md` finding ("momentum remains the stronger comparator on average"), which reflected an earlier, weaker ensemble (+15 bps). The current ensemble is materially stronger.

## Reproduction

```bash
cd agent
npm run eval:generate-heldout -- --seed=20260607 --dev=20 --test=100 --ticks=14 evals/generated
npm run eval:multi-regime:offline -- evals/generated/market-paths-held-out.json traces/ho.json --summary
# inspect traces/ho.json -> aggregate.aiAverageNetRoiBps, comparatorAverageNetRoiBps, aiWinsByComparator
```

## Caveats

- Offline deterministic path, synthetic fixtures — not a live-model claim. A controlled live run (now possible with the seeded keeper) should confirm directionally.
- Results are net of the stated cost model; live testnet gas is larger and is handled separately by the gas-adjusted accounting and the (opt-in) dynamic cost gate.
