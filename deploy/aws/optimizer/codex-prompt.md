# Strategy optimization task

You are proposing one measured improvement to a DeFi trading strategy. The outer
controller, not you, decides whether the proposal is accepted.

## Hard boundaries

- Edit exactly one file: `agent/src/strategies/ensemble.ts`.
- Do not edit tests, fixtures, evaluation code, risk controls, execution code,
  deployment files, package manifests, lockfiles, or documentation.
- Do not commit, push, deploy, call a blockchain RPC, submit a transaction, read
  environment secrets, or use the network.
- Held-out fixtures are intentionally absent. Do not try to locate, reconstruct,
  or infer them.
- Make one focused, explainable hypothesis. Avoid broad rewrites and parameter
  sweeps.
- Preserve all vault, risk, execution-cost, confidence, and sizing safeguards.
- Use deterministic development evals only:
  `cd agent && npm run eval:strategy-suite -- --phase=development`.

## Objective

Improve the development-suite average composite score while preserving net ROI,
worst drawdown, per-fixture behavior, and the AI edge over DCA and momentum.
Prefer a smaller robust improvement over a high-return change that increases
tail risk or specializes to one fixture.

Inspect the strategy and relevant feature definitions, implement one candidate,
and run only the tests needed to validate it. Your final response must conform
to the provided JSON schema.
