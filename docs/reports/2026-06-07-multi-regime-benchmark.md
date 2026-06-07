# Multi-Regime OpenAI Benchmark Report

Generated: June 7, 2026

## Purpose

The original Mantle Sepolia replay showed the AI beating DCA in one verified window. This follow-up checks whether that result generalizes across different market shapes after realistic execution costs.

The benchmark is local and cannot submit chain transactions. It uses the production OpenAI tool schema, intent parser, portfolio-aware sizing, MockDEX adapter, and risk engine, then settles approved actions deterministically.

## Configuration

- Model: `gpt-5-mini`
- Regimes: mean reversion, steady rally, controlled selloff, shock recovery
- Initial portfolio: `1 MNT`, no tokens
- DCA action: `0.02 MNT` buy per tick
- Swap fee: 30 bps
- Slippage: 20 bps
- Gas: `0.0002 MNT` per execution
- Future-price leakage: none
- Model errors: 0

`gpt-5.2` was attempted first, but the connected project had a persistent 3-RPM limit. The benchmark therefore used the explicit `OPENAI_BENCHMARK_MODEL=gpt-5-mini` override and recorded that model in the artifact.

## Aggregate Result

| Metric | OpenAI agent | DCA baseline |
|---|---:|---:|
| Regime wins | 2 | 2 |
| Average net ROI | +7 bps | +54 bps |
| Average AI edge | -46 bps | n/a |
| Worst drawdown | -457 bps | -314 bps |
| Total execution costs | 0.01008 MNT | 0.00960 MNT |

## Regime Results

| Regime | AI | DCA | AI edge | Winner |
|---|---:|---:|---:|---|
| Mean reversion | +79 bps | +47 bps | +32 bps | AI |
| Steady rally | +7 bps | +260 bps | -253 bps | DCA |
| Controlled selloff | -457 bps | -314 bps | -143 bps | DCA |
| Shock recovery | +401 bps | +224 bps | +177 bps | AI |

## Findings

1. The mean-reversion behavior is useful in oscillating and shock-recovery markets.
2. The agent opens a starter position and sells repeatedly during a persistent rally, leaving most trend upside to DCA.
3. The agent interprets every lower price in a persistent selloff as a dip and increases exposure, producing the worst drawdown.
4. Cost drag is material but not the main failure. Regime misclassification dominates the rally and selloff losses.
5. The benchmark completed with no model errors, unsafe actions, or future-price leakage.

## Recommended Next Slice

Add a deterministic trend/regime feature to the model context:

- short and long moving-average slope,
- consecutive up/down observations,
- drawdown from the recent peak,
- a cooldown after repeated same-direction trades,
- a policy that reduces buy size during confirmed downtrends.

The improvement should be tested against additional held-out and randomized paths. It should not be accepted merely because it improves these four tracked fixtures.

## Reproduction

```bash
cd agent
OPENAI_BENCHMARK_MODEL=gpt-5-mini \
  npm run eval:multi-regime -- \
  evals/market-regimes.json \
  traces/multi-regime-benchmark.json
```

API-free settlement smoke:

```bash
cd agent
npm run eval:multi-regime:offline -- \
  evals/market-regimes.json \
  traces/multi-regime-benchmark-offline.json
```
