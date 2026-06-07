# Regime-Aware Agent Upgrade

Generated: June 7, 2026

## Scope

This slice strengthens the AI decision boundary without expanding transaction authority. The model still proposes high-level intent; deterministic code builds calldata, applies sizing and confidence policy, then sends the result through the existing risk and simulation gates.

Implemented:

- no-lookahead market feature engine;
- structured regime, confidence, expected-edge, sizing, and invalidation output;
- confidence and execution-cost policy;
- downtrend buy and uptrend sell sizing constraints;
- replayable decision analysis;
- seeded development and held-out fixture generation;
- DCA, momentum, mean-reversion, and hold comparators.

## Live Contract Smoke

Model: `gpt-5-mini`

Fixture: four-point controlled selloff.

Result:

| Metric | AI | DCA |
|---|---:|---:|
| Net return | 0 bps | -55 bps |
| Executions | 0 | 4 |
| Model errors | 0 | 0 |
| Maximum drawdown | 0 bps | -55 bps |

The model accepted the strict tool schema and held through the decline. This proves the upgraded output and policy path work with a real OpenAI model; it does not prove broad strategy superiority.

## Held-Out Offline Smoke

Configuration:

- Seed: `20260607`
- Development paths: 20
- Held-out paths: 100
- Observations per path: 14
- Swap fee: 30 bps
- Slippage: 20 bps
- Gas: `0.0002 MNT`

Held-out averages:

| Strategy | Average net return |
|---|---:|
| Regime-aware deterministic policy | +15 bps |
| Momentum | +17 bps |
| Always hold | 0 bps |
| Mean reversion | -24 bps |
| DCA | -48 bps |

The regime policy beat DCA on 67 of 100 paths and mean reversion on 61, but beat momentum on only 46 and hold on 27. The positive average is concentrated in fewer profitable paths, so momentum remains the stronger comparator.

## Interpretation

The original failure mode is addressed structurally: a falling price is no longer automatically treated as a dip. The new agent can identify persistent directional movement, estimate whether edge exceeds costs, and preserve the model's structured reasoning for replay.

The remaining AI problem is evidence, not another prompt tweak. A larger sampled live-model run and historical MNT windows should be added before changing thresholds based on these generated results.

## Reproduction

```bash
cd agent
npm run eval:generate-heldout -- --seed=20260607 --dev=20 --test=100 --ticks=14 evals/generated
npm run eval:multi-regime:offline -- \
  evals/generated/market-paths-held-out.json \
  traces/heldout-test.json \
  --summary
```
