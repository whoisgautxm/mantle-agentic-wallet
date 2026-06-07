# Live Human-vs-AI Run: Analysis and Claude Code Handoff

> ## Implementation status (updated by Claude Code, 2026-06-07)
>
> The P0 measurement-integrity slice is substantially implemented (TDD, all suites green: 164 agent vitest + 40 forge + web build). No strategy thresholds were changed.
>
> - **P0.1 Atomic observations — DONE.** `readVaultState` now pins every read (balance, limits, token, DEX price) to one block and returns `blockNumber`; runners append the canonical same-block price to history. Regression test `chain.readVaultState.test.ts` reproduces/guards the 369 bps split-snapshot bug. (commit `0264f26`)
> - **P0.2 Terminal traces — DONE.** Every started tick emits exactly one terminal `agent.final_action`; the loop catch records typed `reverted`/`error` outcomes with `tickId`, tx hash, and gas via the new `ExecuteRevertedError`. (commit `4cf53ab`)
> - **P0.3 Replay false positive — DONE.** `FAILED_SIMULATION_RISK` is now same-tick (`simulationFailureExecutions`), not aggregate; regression tests added. (commit `4086e05`)
> - **P0.4 Real cost accounting — DONE.** `submitExecute` returns realized `gasUsedWei`/`gasCostWei`; runners trace per-tick + cumulative gas and gas-adjusted ROI; pure `gasAdjustedRoiBps` helper tested against this report's −452 bps figure. (commit `796ccc7`)
> - **P0.5 Dashboard provenance — DONE.** Root cause fixed: the dashboard read a stale duplicate `web/data/addresses.json` (old vaults `0xd9a1…`/`0xD786…`); all importers now read the single `shared/addresses.json`, and the copy was deleted so it cannot drift again. Added a run-provenance banner (LIVE/SNAPSHOT badge, deployment addresses + deploy block, block range, vault-only accounting label) that explicitly states when the standing reflects a tracked snapshot rather than a live run. Web build/lint/typecheck/tests green.
>
> **The full P0 measurement-integrity slice is now complete.**
>
> **P1 progress (started):** the **dynamic execution-cost gate** (`risk/costGate.ts`) and **quote-to-submit freshness guard** (`risk/freshness.ts`) are implemented as pure, tested modules and wired into the AI submit path, env-gated (`AGENT_DYNAMIC_COST_GATE`, `AGENT_MAX_BLOCK_DRIFT`, default off) so they are ready for a controlled run without changing default behavior. The cost gate blocks a trade whose expected edge can't clear observed gas+fees+slippage; the freshness guard skips submission when the pinned observation block has drifted too far behind head (the OracleFloorTooLow race in section 10). 170 agent + 40 forge green.
>
> **Seeded/scripted keeper (P1/P2) — DONE.** `priceSequence.ts` provides deterministic generators (mulberry32, a fixed 40-tick regime script, and a seeded walk) tested in `priceSequence.test.ts`. The keeper now supports `KEEPER_PRICE_MODE=scripted|seeded|walk` (default `walk` = unchanged). In scripted/seeded mode AI and DCA face an identical, reproducible price path across runs — the prerequisite for a trustworthy multi-seed AI-vs-DCA benchmark. 178 agent + 40 forge green.
>
> Remaining P1 items (explicit ensemble modes, recovery-state logic, dynamic gas cost gate, quote-to-submit freshness re-quote, and a seeded/scripted keeper to remove the `Math.random` race at its source).


Run date: June 7, 2026  
Run window: 07:21:12-07:27:09 UTC (12:51:12-12:57:09 IST)  
Repository commit under test: `f7f51c7f2eec886a389aa79088a933f4732369e0`  
Network: Mantle Sepolia (`chainId=5003`)  
AI provider/model: OpenAI `gpt-5.2`  
Live strategy mode: `AGENT_STRATEGY=ensemble`

## 1. Executive Summary

This was a fresh, approximately six-minute on-chain run of the OpenAI agent against the fixed DCA "human" baseline. Both vaults began with `1 MNT` and no MockToken exposure. The keeper first produced a roughly 5.18% decline, followed by a roughly 5.04% recovery from the low.

There are two valid but materially different winner calculations:

| Accounting view | AI | DCA baseline | Winner |
|---|---:|---:|---|
| Current dashboard/vault-only ROI | `0 bps` | `+6 bps` | Baseline by `6 bps` |
| Gas-adjusted on-chain ROI | `0 bps` before API cost | approximately `-452 bps` | AI by approximately `452 bps` |

The current dashboard metric excludes transaction gas because gas is paid by the runner EOA rather than deducted from the vault. Under that existing project metric, the baseline won this run by `0.06%`. Under actual on-chain execution economics, the baseline spent `0.0459075418149 MNT` in gas while trading only `0.035 MNT`, turning its small vault gain into an approximately `-4.52%` net result.

The most honest conclusion is:

> The baseline won the project's current vault-only comparison, while the AI won after observed transaction gas. The run is too short and the accounting model is too incomplete to claim general strategy superiority for either side.

The AI's safety behavior was strong but its opportunity capture was weak:

- It held on all 10 decisions.
- It had no drawdown and made no unsafe transaction attempt.
- It correctly stayed out of the confirmed downtrend.
- It failed to enter after the recovery.
- The deterministic ensemble prior also independently returned `hold` on all 10 observed histories.
- The live ensemble integration is only a veto/cap layer. It cannot turn a model `hold` into a deterministic trade.

Several infrastructure and evaluation defects were discovered:

1. Oracle history and vault state were inconsistent on one AI tick by `369 bps`.
2. One reverted baseline transaction has no `agent.final_action` trace and is excluded from the OpenAI replay summary.
3. The OpenAI replay evaluator reports a false critical finding when one safely blocked simulation and other successful executions coexist in the same run.
4. The dashboard displayed an older tracked snapshot from different vaults and blocks, not this fresh run.
5. Actual testnet gas was drastically higher than the configured/offline execution-cost assumptions.

These measurement issues should be fixed before tuning strategy thresholds.

## 2. Purpose

The run tested whether the newly implemented regime-routed ensemble improves the live OpenAI agent against the DCA baseline.

Specifically, it tested:

- real OpenAI structured decisions;
- the optional deterministic ensemble prior;
- equal configured AI and baseline cadence;
- on-chain MockDEX execution through guarded vaults;
- simulation, oracle, risk, and allowlist gates;
- JSONL trace replay;
- portfolio performance through a decline and recovery.

This was not intended to prove statistical superiority. It is one short random path.

## 3. Run Configuration

The run used process-only overrides. No `.env` values were modified.

```bash
cd agent

AGENT_STRATEGY=ensemble \
AGENT_INTERVAL_MS=30000 \
BASELINE_INTERVAL_MS=30000 \
KEEPER_INTERVAL_MS=20000 \
npm run demo -- --fresh-trace --skip-scenario-eval
```

Effective settings:

| Setting | Value |
|---|---|
| AI provider | `openai` |
| AI model | `gpt-5.2` |
| AI strategy | `ensemble` prior |
| AI configured interval | 30 seconds |
| Baseline configured interval | 30 seconds |
| Keeper configured interval | 20 seconds |
| DCA size | `0.005 MNT` per attempt |
| Model execution-cost estimate | `60 bps` |
| Edge buffer | `10 bps` |
| Model trade threshold | greater than `70 bps` gross edge |
| Oracle provider | MockDEX reference |
| Trace mode | fresh JSONL trace |

Contracts used from `shared/addresses.json`:

| Contract | Address |
|---|---|
| AI vault | `0x31227Df6b26Ed12D966Fe28667c6c6760DAa3EFa` |
| Baseline vault | `0x345880aDca2F395b208DE6b33aE0c783D418FcD5` |
| MockDEX | `0x1ff284d6eC1E255Fd6Bea7cfAC26412582B25A4B` |
| MockToken | `0x5fB4D8EA45bd32D3F6F79d587dB50FD1d6C17D35` |
| MockOracle | `0x0ECbE10BCc6f0625f24458F17c979520DFb7bEb2` |

## 4. Market Path

The observed market moved through three broad phases:

1. Initial decline from `2.0000` to a low of `1.89635 MNT/token`.
2. Recovery toward and briefly above the initial price.
3. End near `1.99203 MNT/token`.

| Market metric | Result |
|---|---:|
| Start price | `2.000000000000000000` |
| Minimum observed price | `1.896352680581631617` |
| Maximum observed price | `2.032815238343105509` |
| Final synchronized price | `1.992028273361364662` |
| Low versus start | `-518 bps` |
| High versus start | `+164 bps` |
| Final versus start | `-39 bps` |
| Recovery from low to final | `+504 bps` |

The path rewarded two different behaviors:

- staying in cash during the decline;
- obtaining some exposure before or during the recovery.

The AI achieved the first but not the second. DCA accepted a small drawdown and benefited from the recovery.

## 5. Final Portfolio Results

The final values were read from both vaults against the same final MockDEX price after all processes stopped.

### AI

| Metric | Result |
|---|---:|
| Starting portfolio | `1.000000000000000000 MNT` |
| Final MNT | `1.000000000000000000 MNT` |
| Final token balance | `0` |
| Final portfolio | `1.000000000000000000 MNT` |
| Vault-only ROI | `0 bps` |
| Maximum drawdown | `0 bps` |
| Executed trades | `0` |
| Holds | `10` |

### Baseline

| Metric | Result |
|---|---:|
| Starting portfolio | `1.000000000000000000 MNT` |
| Final MNT | `0.965000000000000000 MNT` |
| Final token balance | `0.017918345711057372 MOCK` |
| Final token value | approximately `0.035693851268289630 MNT` |
| Final vault portfolio | `1.000693851268289630 MNT` |
| Vault-only gain | `0.000693851268289630 MNT` |
| Vault-only ROI | `+6 bps` after integer truncation |
| Exact vault-only return | approximately `+0.069385%` |
| Maximum replay drawdown | `-3 bps` |
| Successful buys | `7` |
| Simulation-blocked buys | `1` |
| On-chain reverted buys | `1` |

## 6. Gas-Adjusted Result

The current portfolio calculation values only assets inside each vault. It does not subtract gas paid by the runner wallet.

Actual baseline receipts:

| Transaction | Status | Gas used | Gas cost |
|---|---|---:|---:|
| `0xb069...f5d9` | Reverted | 136,463 | `0.0068231636463 MNT` |
| `0xed0d...8174` | Success | 170,298 | `0.0085149170298 MNT` |
| `0xd0fa...971d` | Success | 101,898 | `0.0050949101898 MNT` |
| `0x2067...b85e` | Success | 101,898 | `0.0050949101898 MNT` |
| `0xf3d1...2c70` | Success | 101,898 | `0.0050949101898 MNT` |
| `0xb762...8bf3` | Success | 101,898 | `0.0050949101898 MNT` |
| `0xbbfe...a303` | Success | 101,898 | `0.0050949101898 MNT` |
| `0x8228...006a` | Success | 101,898 | `0.0050949101898 MNT` |

Aggregate economics:

| Metric | Result |
|---|---:|
| Successful trade notional | `0.035 MNT` |
| Total observed gas | `0.0459075418149 MNT` |
| Gas as percentage of successful trade notional | `131.16%` |
| Vault trading gain | `+0.000693851268289630 MNT` |
| Gas-adjusted baseline PnL | `-0.045213690546610370 MNT` |
| Gas-adjusted baseline ROI | approximately `-452 bps` |

The AI submitted no transactions, so its chain gas was zero. Its OpenAI API cost was not recorded and is therefore excluded. Keeper/oracle update gas is shared test infrastructure and is also excluded.

### Why this matters

The configured model assumes `60 bps` of execution cost and the held-out offline benchmark used `0.0002 MNT` gas per execution. This live run observed approximately `0.0051-0.0085 MNT` per successful baseline execution.

For a `0.005 MNT` DCA order, one normal successful transaction cost approximately the same as the entire trade notional. The baseline is not economically viable at this order size under the observed testnet fee conditions.

Before claiming a winner, the project should display:

- vault-only ROI;
- realized gas;
- gas-adjusted ROI;
- optional model/API cost separately;
- a clearly labeled official score.

## 7. Tick-Level AI Analysis

The AI made 10 decisions. Every decision was `hold`.

| Tick | Price | Deterministic regime | Feature confidence | Model confidence | Key reason |
|---|---:|---|---:|---:|---|
| `f6fc58ee` | 2.00000 | uncertain | 10 | 60 | Only one observation |
| `e489e21f` | 1.99169 | uncertain | 20 | 60 | Weak negative drift, insufficient history |
| `60dad8c1` | 1.94180 | uncertain | 30 | 68 | Two down moves, no stabilization |
| `dd4090f9` | 1.90113 | trend_down | 94 | 82 | Confirmed downtrend; preserve cash |
| `717b3b38` | 1.91102 | uncertain | 50 | 60 | Only one small recovery move |
| `9c616913` | 1.91030 | uncertain | 50 | 58 | Flat after decline |
| `8c0d5e5f` | 1.99664 | uncertain | 50 | 58 | Sharp rebound but long momentum still slightly negative |
| `3dc99349` | 1.98458 | uncertain | 50 | 58 | Mixed short/long signals |
| `61116675` | state: 2.03282; history: 1.96040 | uncertain | 50 | 58 | Inconsistent price snapshot; model saw negative history |
| `99192850` | 1.99203 | range | 69 | 69 | No range extreme and no inventory |

### Strong behavior

- The model did not buy into the confirmed downtrend.
- Its explanations matched the supplied deterministic features.
- It supplied explicit invalidation conditions.
- It did not fabricate inventory or propose invalid sells.
- It preserved the initial `1 MNT`.
- No stale-oracle execution or failed-simulation execution occurred.

### Weak behavior

- It produced no executable proposal during a roughly 5% recovery.
- It repeatedly set `expectedEdgeBps=0`, even when the latest rebound was `+451 bps`.
- Its confidence remained around 58 while deterministic confidence was often 50, but confidence never translated into a probing trade.
- It relied on long-window momentum crossing positive before entry, which delayed recovery participation.
- Because every model proposal was already `hold`, the ensemble prior had no opportunity to cap or approve an executable trade.

## 8. What the Ensemble Prior Actually Did

The exact deterministic ensemble was replayed against all 10 AI observations with:

- baseline sizing reference: `0.005 MNT`;
- estimated execution cost: `60 bps`;
- edge buffer: `10 bps`.

It also returned `hold` on all 10 ticks.

Important cases:

- Confirmed downtrend tick: held because the vault had no token inventory and dip-buying is forbidden.
- First large rebound: remained `uncertain` because there was only one consecutive up move and long momentum was still slightly negative.
- Final range tick: calculated `187 bps` distance from the prior mean, but the price was above the mean. With no token inventory, it could not sell, and the range policy does not buy above the mean.

The live prior behavior in `brain.ts` is also intentionally asymmetric:

```text
model trade + prior hold       -> hold
model trade + conflicting prior -> hold
model trade + aligned prior     -> capped trade
model hold                      -> hold immediately
```

Therefore, `AGENT_STRATEGY=ensemble` currently behaves like an intersection of model and deterministic approvals. It improves precision/safety but can reduce recall/opportunity capture.

This is not equivalent to the offline held-out evaluator, where the ensemble acts directly. The offline `+63 bps` result cannot be assumed to transfer to the live model-plus-prior path.

## 9. Data Consistency Defect

On tick `61116675`, the trace recorded:

| Source | Price |
|---|---:|
| Last price in `priceHistory` | `1.960397936019237484` |
| `state.priceWei` | `2.032815238343105509` |
| Difference | `369 bps` |

The model's deterministic features were calculated from the older history price, while the system prompt contained the newer vault-state price. The rationale then described negative latest momentum even though the state price had jumped.

The cause is visible in `agent/src/agent.ts`:

1. read oracle;
2. append oracle price to history;
3. perform multiple RPC reads for vault state;
4. read DEX price again inside `readVaultState`;
5. keeper may update the DEX/oracle between those operations.

`readVaultState` itself performs multiple independent reads without pinning a block number, so balances, limits, token inventory, and price are not guaranteed to come from one block.

### Required fix

Create an atomic observation boundary:

1. Read a block number once.
2. Read all vault contracts, balances, token balance, DEX price, and oracle price at that block.
3. Append exactly that canonical price to history.
4. Compute features from the same snapshot.
5. Trace `blockNumber`, `blockHash`, and snapshot age.
6. Reject or retry observations where oracle and DEX data cannot be aligned.

This is higher priority than strategy threshold tuning.

## 10. Execution Race and Oracle-Floor Reverts

The first baseline transaction reverted on-chain:

```text
0xb069558177661b2d19d198882113b26f05b0c82af7dc82a50f46f8355790f5d9
```

Another baseline attempt was blocked during simulation with selector:

```text
0x1c198326
```

That selector decodes to:

```solidity
OracleFloorTooLow(uint256 minOut, uint256 floor)
```

The keeper updates both MockDEX and MockOracle every 20 seconds. A quote/minimum output can become incompatible with the newer on-chain oracle floor between:

1. quote;
2. simulation;
3. transaction submission;
4. transaction inclusion.

The safety system behaved correctly by reverting/blocking rather than accepting a stale floor. The operational workflow is still too race-prone for a clean demo.

### Recommended execution hardening

- Re-quote and re-simulate immediately before submission.
- Record quote block and simulation block.
- Reject a submission when the head block has advanced beyond a configurable tolerance.
- Increase the keeper interval during live model demos.
- Prefer a deterministic scripted keeper that changes price only after both runners finish a tick.
- Trace structured revert data and decoded custom-error arguments.
- Add a controlled retry policy for quote-staleness errors only.
- Never retry policy, allowlist, balance, or authorization errors automatically.

## 11. Trace Integrity Defect

The trace contains 19 started ticks:

- 10 AI ticks;
- 9 baseline ticks.

The first baseline tick has:

- observation;
- quote;
- decision;
- passing simulation;
- passing risk;
- an on-chain reverted transaction;
- `agent.tick.error` without a `tickId`;
- no `agent.final_action`.

Consequences:

- `traceEval` reports `MISSING_FINAL_ACTION`.
- The OpenAI replay groups only 18 complete ticks.
- The reverted transaction is absent from replay runner statistics.
- Gas and failure rates are understated unless receipts are analyzed separately.

The root cause is the outer baseline loop catch. `tickId` is local to `tick()`, while the catch writes an error with only `runner` and `error`.

### Required trace fix

Every started tick must end in exactly one terminal event:

```text
executed | hold | blocked | reverted | error | cancelled
```

Suggested implementation:

- catch execution errors inside `tick()` where `tickId` is available;
- return/throw a typed execution error containing transaction hash and receipt;
- write `agent.final_action` with `outcome="reverted"` for mined reverts;
- write `outcome="error"` for pre-submission failures;
- include decoded error, tx hash, receipt block, gas used, and gas cost;
- make trace evaluation fail when started ticks and terminal events are not one-to-one.

## 12. OpenAI Replay Evaluation

The first replay-grader attempt used `gpt-5.2` and received a temporary TPM rate limit:

```text
429 tokens per minute
used: 8301
requested: 9060
retry after: approximately 44 seconds
```

The retry used `OPENAI_EVAL_MODEL=gpt-5-mini`.

Model grader result:

| Score | Result |
|---|---:|
| Overall | 74 |
| Safety | 92 |
| Decision quality | 68 |
| Evidence quality | 60 |
| AI-vs-baseline | 50 |
| Model verdict | pass |

The model grader correctly identified:

- strong AI capital preservation;
- clear AI rationales;
- fresh oracle evidence;
- small positive vault-only baseline ROI;
- correct blocking of the failed baseline simulation;
- insufficient live AI execution evidence.

### Evaluator false positive

The final report has `ok=false` because local evaluation emits:

```text
FAILED_SIMULATION_RISK
baseline has simulation failures in a trace that also contains execution
```

The local rule checks aggregate runner counts:

```typescript
if (runner.simulationFailures > 0 && runner.executed > 0) {
  // critical
}
```

This is incorrect. A runner may safely block one failed simulation and successfully execute different ticks. The critical condition must be evaluated per tick:

```text
simulation failed AND the same tick executed
```

`traceEval.ts` already applies the correct same-tick logic. `openAiReplayEval.ts` should reuse that logic instead of using aggregate counts.

### Hold-policy evidence issue

The grader declared `winner=insufficient-data` because AI hold ticks have no target/selector/on-chain allowlist evidence. That evidence is not applicable when no transaction is proposed.

Recommended change:

- add `policyEvidenceSource="not-applicable"` for holds;
- do not require execution-policy evidence for a hold;
- allow portfolio outcomes to determine a provisional winner;
- separately label execution-safety comparison as insufficient when one runner never trades.

## 13. Dashboard Mismatch

The browser dashboard loaded successfully, but its headline comparison was not this run.

It displayed:

- AI portfolio: `1.00279 MNT`;
- baseline portfolio: `1.01241 MNT`;
- AI leading by `+0.35%`;
- tracked blocks `39622400-39622916`;
- older vaults beginning `0xd9a1...` and `0xD786...`.

The fresh run used:

- blocks approximately `39636102-39636276`;
- AI vault `0x31227...`;
- baseline vault `0x345880...`.

The page explicitly indicated that it was rendering a tracked fast snapshot. This is useful for stable demos, but it is misleading during a fresh live comparison unless clearly separated.

### Dashboard improvement

Add a run selector and provenance banner:

```text
LIVE TRACE
runId: ...
vault deployment: ...
block range: ...
started: ...
last updated: ...
accounting: vault-only / gas-adjusted
```

The dashboard should never label an older snapshot as the current leader while a new run is active.

## 14. Fairness and Experimental Limitations

This run should not be used as a broad performance claim because:

- It is one random, non-reproducible path.
- The keeper uses `Math.random()`.
- The configured intervals were equal, but actual tick cadence differed due to model latency and transaction confirmation.
- AI observed 10 ticks; baseline started 9.
- AI and baseline did not always observe precisely the same price/block.
- One AI observation contained a 369 bps internal price mismatch.
- Vault-only ROI excludes gas.
- Gas-adjusted ROI excludes OpenAI API cost.
- MockDEX has simplified liquidity/fee behavior.
- The dashboard displayed a historical snapshot from another deployment.
- The ensemble live prior is not behaviorally equivalent to the offline direct ensemble.

## 15. Prioritized Improvement Plan

### P0: Measurement integrity

Do these before strategy tuning.

1. **Atomic observations**
   - Pin one block per tick.
   - Read price, oracle, balances, and limits from that block.
   - Trace block metadata.

2. **Complete terminal traces**
   - Guarantee one final action for every started tick.
   - Add typed `reverted` and `error` outcomes.

3. **Real cost accounting**
   - Fetch receipt gas and effective gas price.
   - Report vault-only and gas-adjusted ROI.
   - Record OpenAI token usage and estimated API cost separately.

4. **Fix replay local finding**
   - Detect failed-simulation execution on the same tick only.
   - Add a regression test for one blocked simulation plus later success.

5. **Align dashboard and run**
   - Add `runId`, deployment, block range, and data source.
   - Default to the active run when present.

### P1: Make live ensemble behavior testable

The current hybrid path requires both model and prior to approve a trade. Add explicit strategy modes:

```text
model
ensemble-direct
model-with-ensemble-veto
model-with-ensemble-advice
```

Recommended experimental mode:

1. Compute deterministic ensemble intent before the model request.
2. Include it in the model prompt as structured advice.
3. Ask the model to accept, reduce, or reject it with a reason.
4. Preserve deterministic safety and sizing caps.
5. Trace model proposal, prior proposal, arbitration result, and final action separately.

This allows evaluation of:

- model-only;
- deterministic-only;
- strict intersection;
- model arbitration.

### P1: Recovery-state logic

The stateless regime classifier recognized the downtrend but lost transition context after the first bounce.

Add a small regime state machine:

```text
trend_down -> stabilization -> recovery_probe -> trend_up/range
```

Possible recovery evidence:

- prior regime was `trend_down`;
- drawdown was meaningful;
- latest return is strongly positive;
- price reclaims a short moving average;
- volatility is not expanding;
- no new low for N observations.

Any recovery entry should be small and cost-aware. Do not tune this from only the current run.

### P1: Dynamic execution-cost gate

Replace the fixed `60 bps` assumption with observed cost:

```text
estimatedGas * feePerGas / tradeNotional
```

Then require:

```text
expectedEdgeBps > feeBps + slippageBps + gasBps + bufferBps
```

The cost gate must run after simulation produces a gas estimate and before submission.

The same accounting should apply to AI and DCA. A `0.005 MNT` trade should be blocked when its expected gain cannot plausibly recover a roughly `0.005 MNT` gas charge.

### P1: Quote-to-submit freshness

- Re-quote before simulation.
- Simulate at the latest block.
- Verify head/block drift before submission.
- Retry only decoded quote/oracle freshness errors.

### P2: Controlled live benchmark

Replace `Math.random()` for benchmark runs with a seeded/scripted keeper.

Recommended 40-tick sequence:

1. 8 flat/warm-up ticks;
2. 8 controlled downtrend ticks;
3. 6 stabilization/recovery ticks;
4. 10 sustained rally ticks;
5. 8 range ticks.

Run at least:

- model-only;
- ensemble-direct;
- current veto/cap hybrid;
- DCA;
- always-hold.

Record:

- gross and net ROI;
- gas;
- API cost;
- drawdown;
- turnover;
- failed/reverted attempts;
- time in market;
- opportunity capture after regime transitions.

### P2: API grader resilience

- Add retry-after handling and exponential backoff.
- Reduce the replay prompt by summarizing old ticks.
- Avoid sending all verbose rationales when aggregate features suffice.
- Default grader to a smaller model if the primary model is near TPM limits.

## 16. Acceptance Criteria for the Next Live Run

The next run should not be considered valid unless:

- every runner uses the same canonical price/block per comparison tick;
- every started tick has one terminal event;
- the dashboard shows the same run ID and deployment;
- actual gas is recorded;
- both vault-only and gas-adjusted ROI are shown;
- no aggregate evaluator false positive occurs;
- the live strategy mode is explicit;
- ensemble and model proposals are separately traceable;
- the run contains at least one controlled recovery and one sustained trend;
- results are reproduced over multiple seeds or scripted paths.

Suggested performance questions:

1. Does AI preserve capital better than DCA during the downtrend?
2. Does it enter the recovery within a bounded number of ticks?
3. Does it avoid uneconomic trades after actual gas?
4. Does the hybrid improve over both model-only and ensemble-direct?
5. Does the result persist over multiple paths?

## 17. Reproduction and Artifacts

Fresh trace:

```text
agent/traces/agent-events.jsonl
```

Deterministic trace summary:

```text
agent/traces/trace-summary.json
```

OpenAI replay report:

```text
agent/traces/openai-replay-eval-live-2026-06-07.json
```

Commands:

```bash
cd agent

npm run eval:traces -- \
  traces/agent-events.jsonl \
  traces/trace-summary.json

OPENAI_EVAL_MODEL=gpt-5-mini \
npm run eval:openai-replay -- \
  traces/agent-events.jsonl \
  traces/openai-replay-eval-live-2026-06-07.json
```

The first OpenAI replay attempt with `gpt-5.2` was rate-limited. The `gpt-5-mini` retry completed and wrote the report, but exited non-zero because of the aggregate false-positive critical finding described above.

## 18. Recommended Claude Code Starting Point

Start with a measurement-integrity slice, not a strategy-threshold change:

1. Add atomic block-pinned observations and tests.
2. Guarantee terminal trace events for reverts/errors.
3. Correct the OpenAI replay same-tick simulation rule.
4. Add receipt gas and gas-adjusted ROI.
5. Add active-run provenance to the dashboard.

After that is green, implement explicit `ensemble-direct` and `model-with-ensemble-advice` modes and run a controlled seeded recovery benchmark.

The key product insight from this run is not simply "baseline won" or "AI won." It is:

> The AI demonstrated strong loss avoidance, but the current live hybrid cannot prove recovery participation, and the existing winner metric omits costs large enough to reverse the result.

## 19. Ready-to-Paste Claude Code Brief

```text
Read docs/reports/2026-06-07-live-human-vs-ai-run-README.md completely before editing.

Implement the P0 measurement-integrity slice using TDD:

1. Make each AI/baseline observation block-pinned and internally atomic. Price history,
   oracle, DEX price, vault balances, token balance, and limits must refer to one block.
   Trace blockNumber/blockHash and add a regression test for the 369 bps split-snapshot bug.

2. Guarantee exactly one terminal agent.final_action for every agent.tick.started.
   Add typed reverted/error outcomes, preserve tickId, transaction hash, decoded revert,
   receipt block, gas used, effective gas price, and gas cost. Cover the first-run
   OracleFloorTooLow revert path with tests.

3. Fix openAiReplayEval local safety logic. A blocked failed simulation plus successful
   executions on other ticks must not produce FAILED_SIMULATION_RISK. Only a failed
   simulation that executes on the same tick is critical. Reuse traceEval semantics.

4. Add realized gas accounting and show both vault-only ROI and gas-adjusted ROI for AI
   and baseline. Do not silently combine OpenAI API cost with chain gas; report model
   usage/cost separately when available.

5. Add active run provenance to the dashboard: runId, deployment addresses, block range,
   trace/snapshot source, start/end time, last update, and accounting mode. Never show an
   old tracked snapshot as the current live winner.

Constraints:
- Do not tune ensemble thresholds in this slice.
- Do not weaken simulation, oracle, allowlist, minOut, or vault guards.
- Preserve unrelated user files and existing behavior outside the measurement path.
- Add focused tests first, then implementation.
- Run agent tests + tsc, forge tests, web lint/tests/build, and browser verification.
- Write a follow-up report with before/after evidence from a controlled replay.

After P0 is green, propose a separate P1 plan for ensemble-direct and
model-with-ensemble-advice modes plus a seeded recovery benchmark. Do not implement P1
in the same commit unless explicitly requested.
```
