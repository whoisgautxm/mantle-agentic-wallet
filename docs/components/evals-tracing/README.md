# Evals and Tracing

Rank: 7

Priority: High

## Goal

Turn the AI wallet into a measurable benchmark. Every prompt, model, risk-rule, adapter, and strategy change should be evaluated against repeatable scenarios.

## Current Project Fit

The project already has unit tests for policy, PnL, Telegram, and model tool parsing. The next step is behavioral evaluation:

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

- `npm run evals` executes deterministic scenarios.
- A failed risk rule can be graded as a success if the agent was blocked safely.
- Results are written to JSON for the dashboard/report.
- Prompt/model changes can be compared run-to-run.

## Resources

- OpenAI agent evals: https://platform.openai.com/docs/guides/agent-evals
- OpenAI evals guide: https://platform.openai.com/docs/guides/evals
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
