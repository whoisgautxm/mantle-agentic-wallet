# 45-Minute OpenAI vs Human/DCA Demo Run

Date: 2026-06-08

This report summarizes a fresh scripted-market demo run comparing the OpenAI-backed ensemble trader against the fixed DCA baseline.

## Run Setup

- Project path: `/Users/gautam/Desktop/Turing-Hackathon`
- Agent provider: OpenAI
- Model override: `gpt-4o-mini`
- Agent strategy: `ensemble`
- Market mode: scripted MockDEX keeper from tick 0
- Agent interval: 60 seconds
- Baseline interval: 60 seconds
- Keeper interval: 45 seconds
- Dashboard: `http://localhost:3000`

The raw demo continued beyond the requested duration before manual cleanup. For an exact benchmark, the trace was clipped to the first 45-minute window:

- Start: `2026-06-08T02:56:29.235Z`
- End: `2026-06-08T03:41:24.393Z`
- Duration: `44.92` minutes

## Trace Health

Trace evaluator result:

- Status: `ok`
- Events: `498`
- Ticks: `78`
- Executed actions: `36`
- Held actions: `42`
- Blocked actions: `0`
- Findings: `0`

This is a clean trace for reporting and replay.

## Final Result

OpenAI/ensemble won the 45-minute comparison.

| Runner | Final actions | Executions | Holds | Final ROI | Gas-adjusted ROI | Gas spent | Final value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OpenAI ensemble | 42 | 0 | 42 | 0 bps | 0 bps equivalent | 0 MNT | 1.0000 MNT |
| DCA baseline | 36 | 36 | 0 | -208 bps | -2001 bps | 0.183416 MNT | 1.001612 MNT |

Winner by raw ROI: OpenAI by `208 bps`.

Winner by gas-adjusted ROI: OpenAI by `2001 bps`.

## What Actually Happened

The AI did not win by making more trades. It won by refusing uneconomic trades.

The scripted market went through several useful regimes:

- Early uncertainty: the AI held while the baseline immediately bought.
- Confirmed downtrend: the AI preserved cash while the baseline kept averaging down.
- Rebound/uptrend: the strategy identified possible long opportunities, but the execution-cost gate rejected them because expected edge did not exceed gas/cost drag.
- Late chop/mean-reversion: the AI returned to no-trade behavior because the market had no cost-worthy deviation.

AI candidate gating breakdown:

- `strategy_hold`: 30
- `economic_pre_gate_hold`: 12

AI rationale breakdown:

- Uncertain regime hold: 20
- Confirmed downtrend cash preservation: 10
- Discount opportunity rejected by economics: 3
- Uptrend-follow opportunity rejected by economics: 9

## Why This Is A Strong Demo Example

This run demonstrates a real DeFi problem: a model can be directionally correct and still should not trade if execution costs dominate expected edge.

The best project story from this run is:

> The AI agent is not a toy price predictor. It combines market regime detection, execution-cost checks, risk gates, and traceable decisions. In this 45-minute run, the DCA baseline traded 36 times and lost heavily after gas, while the AI preserved capital by rejecting trades that were not net-positive.

## Main Limitation

The AI remained fully in cash for the whole 45-minute slice. That is safe and profitable against this baseline, but the next improvement should target controlled re-entry:

- Persist market memory across restarts.
- Lower cost estimates only when a real route/gas quote supports it.
- Add a minimum expected-edge-over-cost margin that can adapt by account size.
- Add a recovery-entry rule so the agent can capture strong rebounds when edge clearly exceeds execution drag.

## Artifacts

- Exact 45-minute trace: `agent/traces/agent-events-45min-openai-vs-human.jsonl`
- Trace evaluator summary: `agent/traces/trace-summary-45min-openai-vs-human.json`
- Parsed performance summary: `agent/traces/summary-45min-openai-vs-human.json`
- Previous raw trace backup: `agent/traces/agent-events-before-45min-2026-06-08T02-56-11-938Z.jsonl`
