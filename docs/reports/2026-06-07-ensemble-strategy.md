# Regime-Routed Ensemble Strategy

Generated: June 7, 2026

## Result

**Acceptance gate: PASS.**

The deterministic offline AI path now routes by the no-lookahead market regime:

- confirmed uptrends use meaningful momentum-following buys and never sell while continuation persists;
- confirmed downtrends preserve cash or trim existing inventory;
- ranges use cost-gated mean reversion;
- shock ticks stay risk-off and permit only small observable recovery entries;
- uncertain regimes hold.

The strategy shares the existing confidence and edge-buffer defaults with the model policy. It still passes through trade normalization, protocol quoting, risk evaluation, simulation assumptions, and transaction-cost settlement.

## Development Calibration

Only the 20 development paths for seed `20260607` were used for calibration. The initial strategy produced `+83 bps` average return with `-126 bps` worst drawdown. Development inspection identified three short rally false positives before reversals or shocks. Adding a 200 bps cumulative-momentum confirmation produced:

| Metric | Ensemble | Momentum |
|---|---:|---:|
| Average net ROI | +79 bps | +13 bps |
| Wins vs momentum | 13 / 20 | - |
| Worst drawdown | -7 bps | - |

No thresholds were changed after the held-out run.

## Held-Out Results

All runs use 100 fresh seeded paths, 14 ticks, 30 bps fee, 20 bps slippage, and `0.0002 MNT` gas.

| Seed | Ensemble ROI | Momentum | DCA | Mean reversion | Hold | Wins vs momentum | Worst drawdown |
|---|---:|---:|---:|---:|---:|---:|---:|
| `20260607` | **+63 bps** | +17 bps | -48 bps | -24 bps | 0 bps | **58 / 100** | -28 bps |
| `20260608` | **+57 bps** | +23 bps | -72 bps | -18 bps | 0 bps | 44 / 100 | -105 bps |
| `99999999` | **+66 bps** | +25 bps | -50 bps | -21 bps | 0 bps | 49 / 100 | -10 bps |

The additional seeds satisfy the required average-ROI robustness check, but their per-path win rates are below 50%. The ensemble wins through larger trend participation and capital preservation, not uniform path-by-path dominance.

## Gate Review

1. Primary held-out average beats momentum, DCA, mean reversion, and hold: **PASS**.
2. Primary held-out wins versus momentum are at least 55/100: **PASS, 58/100**.
3. Worst drawdown is within 10% of the prior regime policy: **PASS, -28 bps versus -31 bps**.
4. Safety and existing tests remain green: **PASS**.
5. Two fresh seeds beat momentum on average: **PASS**.

## Integration

- `createOfflineBenchmarkDecisionRunner()` uses the shared ensemble by default.
- Comparators are unchanged.
- The live model remains the default live strategy.
- Set `AGENT_STRATEGY=ensemble` to enable a deterministic prior that can veto a conflicting model trade or cap an aligned trade. The model still produces structured reasoning, and all existing policy, risk, simulation, and on-chain guards remain active.

## Reproduction

```bash
cd agent
npm run eval:generate-heldout -- --seed=20260607 --dev=20 --test=100 --ticks=14 evals/generated
npm run eval:multi-regime:offline -- evals/generated/market-paths-development.json traces/ensemble-dev-final.json --summary
npm run eval:multi-regime:offline -- evals/generated/market-paths-held-out.json traces/ensemble-heldout-20260607.json --summary

npm run eval:generate-heldout -- --seed=20260608 --dev=20 --test=100 --ticks=14 evals/generated-2
npm run eval:multi-regime:offline -- evals/generated-2/market-paths-held-out.json traces/ensemble-heldout-20260608.json --summary

npm run eval:generate-heldout -- --seed=99999999 --dev=20 --test=100 --ticks=14 evals/generated-3
npm run eval:multi-regime:offline -- evals/generated-3/market-paths-held-out.json traces/ensemble-heldout-99999999.json --summary
```
