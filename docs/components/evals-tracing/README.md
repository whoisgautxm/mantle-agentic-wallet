# Evals and Tracing

Rank: 7

Priority: High

## Goal

Turn the AI wallet into a measurable benchmark. Every prompt, model, risk-rule, adapter, and strategy change should be evaluated against repeatable scenarios.

## Current Project Fit

The project now has unit tests for policy, PnL, Telegram, model tool parsing, tracing, and trace evaluation. Local JSONL traces capture observations, quotes, oracle snapshots, decisions, simulations, risk results, and final actions.

Implemented v1:

- `npm run eval:traces` reads a trace JSONL file.
- `npm run eval:scenarios` runs deterministic risk scenarios without RPC, private keys, or model calls.
- `npm run eval:openai-replay` runs an OpenAI model-backed replay judge against real JSONL traces.
- `npm run eval:multi-regime` runs the real OpenAI decision path across four deterministic price regimes.
- `npm run eval:generate-heldout` creates separate seeded development and held-out market datasets.
- Multi-regime settlement deducts swap fees, slippage, and gas before comparing AI and DCA.
- Multi-regime reports also compare against momentum, mean-reversion, and always-hold strategies.
- It grades whether executed ticks had passing risk and simulation results.
- It verifies failed risk/simulation outcomes do not execute.
- It flags stale-oracle execution.
- It can write a JSON summary for reports and dashboards.
- The dashboard reads trace, scenario, OpenAI replay, and multi-regime summary JSON artifacts and shows replay benchmark status.

The next step is broader scenario-based behavioral evaluation:

- Did the agent choose a safe action?
- Did it obey limits?
- Did it explain decisions?
- Did it beat baseline over a scenario?
- Did a prompt/model change regress behavior?

## Real Problems It Solves

- "The AI made a trade" is not enough evidence.
- Model upgrades can silently change trading behavior.
- Prompts can overfit to the demo.
- The agent may pass unit tests but fail realistic scenarios.
- Judges need a credible Human-vs-AI benchmark story.

## Integration Design

Add:

```text
agent/evals/
  scenarios/
    falling-market.json
    mean-reversion.json
    stale-oracle.json
    low-liquidity.json
    liquidation-risk.json
  graders/
    policy-obedience.ts
    rationale-quality.ts
    pnl-vs-baseline.ts
  run-evals.ts
```

Scenario shape:

```json
{
  "name": "falling-market",
  "prices": ["1.20", "1.12", "1.05", "1.00"],
  "vault": {
    "mnt": "0.2",
    "token": "0"
  },
  "expected": {
    "allowedActions": ["hold"],
    "blockedActions": ["buy"]
  }
}
```

## OpenAI Integration

Use OpenAI tracing or an eval harness to record:

- model input
- selected tool/action
- risk result
- simulation result
- final submitted transaction or hold
- outcome vs baseline

Implemented OpenAI replay eval v1:

- Reads `agent/traces/agent-events.jsonl`.
- Summarizes AI and baseline ticks, final actions, oracle freshness, risk, simulation, gas, and protocol-readiness signals.
- Calls an OpenAI judge model with structured JSON output.
- Writes `agent/traces/openai-replay-eval.json`.
- Scores safety, decision quality, evidence quality, and AI-vs-baseline performance.

Implemented multi-regime eval v1:

- Uses only prices observed up to the current tick, so the model receives no future-price leakage.
- Reuses the production tool schema, intent normalization, MockDEX adapter, and risk engine.
- Runs mean-reversion, steady-rally, controlled-selloff, and shock-recovery fixtures.
- Deducts configurable fees, slippage, and gas from both AI and DCA.
- Records ROI, edge, cost drag, turnover, drawdown, blocked actions, and model errors.
- Retries OpenAI 429 responses using server retry hints instead of grading throttles as strategy holds.
- Supports an API-free deterministic mode for fast CI and settlement regression tests.

Implemented regime-aware eval v2:

- Computes deterministic momentum, short/long slope, volatility, drawdown, latest return, and directional streak features without lookahead.
- Requires the model to return regime, confidence, expected edge, sizing percentage, and an invalidation condition.
- Converts low-confidence and execution-cost-negative trades to holds before protocol quoting.
- Reduces dip-buy capacity in confirmed downtrends and premature sell capacity in confirmed uptrends.
- Preserves structured model analysis in benchmark timelines and OpenAI replay summaries.
- Generates 20 seeded development paths and 100 disjoint held-out paths by default.
- Scores DCA, momentum, mean-reversion, and always-hold comparators on the same prices and costs.
- A live three-request `gpt-5-mini` selloff smoke completed with zero model errors.

The 100-path API-free held-out smoke is encouraging against DCA but not conclusive for the model: the regime policy averaged `+15 bps`, DCA `-48 bps`, mean reversion `-24 bps`, momentum `+17 bps`, and hold `0 bps`. The next evidence threshold is a sampled live-model held-out run and historical MNT windows. Held-out outcomes must not be used as prompt-tuning inputs.

The OpenAI Agents SDK has built-in tracing for model generations, tool calls, guardrails, handoffs, and custom events. OpenAI agent evals support traces, graders, datasets, and eval runs for improving workflow quality. The current project uses a code-first replay judge first; hosted trace grading/datasets can be added once the real-agent trace set is larger.

## Suggested Metrics

- Policy obedience rate.
- Unsafe action proposal rate.
- Risk block rate.
- Simulation failure rate.
- PnL vs DCA.
- Max drawdown.
- Trade frequency.
- Rationale quality.
- Stale-oracle rejection accuracy.
- Slippage-protection accuracy.

## Acceptance Criteria

- `npm run eval:traces` grades replayed JSONL traces. Implemented.
- `npm run eval:openai-replay` grades replayed JSONL traces with a real OpenAI judge model. Implemented.
- A failed risk rule can be graded as a success if the agent was blocked safely.
- Results can be written to JSON for the dashboard/report. Implemented for trace, scenario, OpenAI replay, and multi-regime summaries.
- The dashboard exposes eval artifact status, pass/fail metrics, model-backed scores, and top findings. Implemented.
- Prompt/model changes can be compared run-to-run with the tracked multi-regime fixture. Implemented.
- Development and held-out market paths are reproducible and separated by ID. Implemented.

## Resources

- OpenAI agent evals: https://developers.openai.com/api/docs/guides/agent-evals
- OpenAI evals guide: https://developers.openai.com/api/docs/guides/evals
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
