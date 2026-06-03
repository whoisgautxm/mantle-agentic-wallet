# Evals and Tracing

Rank: 7

Priority: High

## Goal

Turn the AI wallet into a measurable benchmark. Every prompt, model, risk-rule, adapter, and strategy change should be evaluated against repeatable scenarios.

## Current Project Fit

The project now has unit tests for policy, PnL, Telegram, model tool parsing, tracing, and trace evaluation. Local JSONL traces capture observations, quotes, oracle snapshots, decisions, simulations, risk results, and final actions.

Implemented v1:

- `npm run eval:traces` reads a trace JSONL file.
- It grades whether executed ticks had passing risk and simulation results.
- It verifies failed risk/simulation outcomes do not execute.
- It flags stale-oracle execution.
- It can write a JSON summary for reports and dashboards.

The next step is scenario-based behavioral evaluation:

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

The OpenAI Agents SDK has built-in tracing for model generations, tool calls, guardrails, handoffs, and custom events. OpenAI agent evals support traces, graders, datasets, and eval runs for improving workflow quality.

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
- A failed risk rule can be graded as a success if the agent was blocked safely.
- Results can be written to JSON for the dashboard/report.
- Prompt/model changes can be compared run-to-run once deterministic scenarios are added.

## Resources

- OpenAI agent evals: https://platform.openai.com/docs/guides/agent-evals
- OpenAI evals guide: https://platform.openai.com/docs/guides/evals
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
