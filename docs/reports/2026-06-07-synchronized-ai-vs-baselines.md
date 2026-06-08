# Synchronized AI-vs-Baselines Benchmark

Generated: June 7, 2026

## Purpose

This report records the first synchronized Human-vs-AI benchmark for the trading backend after the candidate-assessment architecture was added.

The goal is to avoid unfair live-loop comparisons where the AI and baseline see slightly different prices, blocks, costs, or portfolio states. Every runner in this benchmark receives the same observed price history at the same tick, passes through the same MockDEX quote path, the same risk engine, and the same deterministic settlement model.

## What changed

- Added a synchronized `eval:synchronized` command.
- Added a live synchronized `eval:synchronized:live` command that uses OpenAI only as a constrained candidate critic.
- Added an offline `ai-assisted-ensemble` runner that exercises the new candidate -> structured assessment -> validated decision path.
- Added live-eval reliability controls:
  - persistent candidate-assessment cache,
  - cache hit/miss trace fields,
  - provider rate-limit deferral that does not count throttling as model strategy failure,
  - optional per-regime fresh-assessment budget,
  - conservative `gpt-5.2` pacing default for live candidate assessment.
- Added live model-assessment metrics:
  - candidate events,
  - candidates assessed,
  - approvals and vetoes,
  - invalid vetoes ignored,
  - invalid approvals logged,
  - state-grounding errors,
  - approval execution precision,
  - suppressed feasible candidates,
  - provider rate-limit skips,
  - assessment budget skips,
  - cache hits and misses,
  - incremental value gate versus the deterministic ensemble.
- Added stronger human comparators:
  - DCA.
  - Buy-and-hold with the maximum single risk-approved starter buy.
  - Momentum.
  - Mean-reversion.
  - Hold cash.
  - Deterministic ensemble.
- Added composite scoring to every runner:

```text
composite score =
  net ROI
  - 0.50 * maximum drawdown
  - transaction cost drag
  - blocked action penalties
  - model error penalties
```

## Offline limitation

The held-out results below use the `ai-assisted-ensemble-offline` runner. That runner deterministically approves candidates that already passed the ensemble, normalization, and cost pre-gates.

That is intentional for the broad held-out phase: it proves the synchronized benchmark and candidate-assessment wiring are fair and replayable. It does not by itself prove that a live model adds alpha over the deterministic ensemble.

## Tracked fixture result

Command:

```bash
cd agent
npm run eval:synchronized -- evals/market-regimes.json traces/synchronized-benchmark.json
```

| Metric | AI-assisted | DCA |
|---|---:|---:|
| Regimes | 4 | 4 |
| Wins vs DCA | 2 | 2 |
| Average net ROI | +91 bps | +54 bps |
| Average composite score | +66 bps | -50 bps |
| Worst drawdown | -97 bps | -314 bps |
| Total execution costs | 0.004899658667452830 MNT | 0.009600000000000000 MNT |
| Model errors | 0 | n/a |

Comparator average net ROI:

| Comparator | Avg net ROI |
|---|---:|
| AI-assisted | +91 bps |
| Deterministic ensemble | +91 bps |
| Momentum | +70 bps |
| DCA | +54 bps |
| Buy-and-hold | +14 bps |
| Hold cash | 0 bps |
| Mean-reversion | -10 bps |

## Held-out generalization

The same synchronized command was run on three independent 100-path held-out fixture sets.

| Fixture | AI avg net ROI | DCA avg net ROI | AI edge vs DCA | AI wins vs DCA | AI worst drawdown | DCA worst drawdown |
|---|---:|---:|---:|---:|---:|---:|
| `generated/market-paths-held-out.json` | +63 bps | -48 bps | +111 bps | 94/100 | -28 bps | -588 bps |
| `gen-20260608/market-paths-held-out.json` | +57 bps | -72 bps | +129 bps | 92/100 | -105 bps | -576 bps |
| `gen-99999999/market-paths-held-out.json` | +66 bps | -50 bps | +117 bps | 93/100 | -10 bps | -507 bps |

Held-out comparator average net ROI:

| Fixture | AI | Deterministic ensemble | Momentum | Buy-and-hold | Hold | DCA | Mean-reversion |
|---|---:|---:|---:|---:|---:|---:|---:|
| `generated` | +63 | +63 | +17 | -19 | 0 | -48 | -24 |
| `gen-20260608` | +57 | +57 | +23 | -43 | 0 | -72 | -18 |
| `gen-99999999` | +66 | +66 | +25 | -31 | 0 | -50 | -21 |

Composite-score wins over key comparators:

| Fixture | vs DCA | vs Buy-and-hold | vs Momentum | vs Mean-reversion | vs Hold | vs Deterministic ensemble |
|---|---:|---:|---:|---:|---:|---:|
| `generated` | 98/100 | 97/100 | 64/100 | 82/100 | 27/100 | 0/100 |
| `gen-20260608` | 99/100 | 99/100 | 50/100 | 67/100 | 22/100 | 0/100 |
| `gen-99999999` | 98/100 | 100/100 | 54/100 | 73/100 | 27/100 | 0/100 |

## Live OpenAI candidate-assessment result

The live OpenAI path was then tested with the existing local `OPENAI_API_KEY` and configured `OPENAI_MODEL=gpt-5.2`. The live runner uses the same synchronized benchmark, but calls OpenAI only when the deterministic ensemble produces a candidate. The model must return `assess_trade_candidate`; it cannot change action, size, or route.

Short smoke command:

```bash
cd agent
npm run eval:synchronized:live -- \
  evals/live-candidate-assessment-smoke.json \
  traces/live-candidate-assessment-smoke-openai.json
```

Short smoke result:

| Metric | Value |
|---|---:|
| Candidates assessed | 2 |
| Approvals | 2 |
| Vetoes | 0 |
| Approved executions | 2 |
| Approval precision | 10000 bps |
| Invalid vetoes ignored | 0 |
| Invalid approvals logged | 0 |
| State-grounding errors | 0 |
| Model errors | 0 |

Tracked live command:

```bash
cd agent
OPENAI_BENCHMARK_MAX_RETRIES=2 npm run eval:synchronized:live -- \
  evals/market-regimes.json \
  traces/synchronized-openai-candidate-assessment.json
```

Tracked live result:

| Metric | OpenAI candidate critic | Deterministic ensemble | DCA |
|---|---:|---:|---:|
| Average net ROI | +62 bps | +91 bps | +54 bps |
| Average composite score | -81 bps | +66 bps | -50 bps |
| Worst drawdown | -97 bps | -97 bps | -314 bps |
| Model errors | 5 | n/a | n/a |
| Incremental value gate | Failed | n/a | n/a |

Live model-assessment quality:

| Metric | Value |
|---|---:|
| Candidates assessed successfully | 5 |
| Approvals | 5 |
| Vetoes | 0 |
| Approved executions | 5 |
| Approval precision | 10000 bps |
| Invalid vetoes ignored | 0 |
| Invalid approvals logged | 0 |
| State-grounding errors | 0 |
| Suppressed feasible candidates | 0 |

The tracked live run failed the benchmark `ok` flag because repeated OpenAI rate limits produced 5 model errors after retries. This is an operational throughput failure, not a malformed-assessment failure. Every completed assessment was grounded, schema-valid, approved, and executed.

The incremental value gate also failed:

```text
AI average composite score: -81 bps
Deterministic ensemble composite score: +66 bps
Composite edge: -147 bps
AI average net ROI: +62 bps
Deterministic ensemble net ROI: +91 bps
Net ROI edge: -29 bps
Drawdown improvement: 0 bps
```

Current conclusion: the live OpenAI critic is semantically safe on completed assessments, but the current model/RPM configuration is not yet reliable enough for full tracked or held-out live benchmarks.

## Cached scheduler result

The live runner now persists successful candidate assessments to a local JSON cache. Repeated benchmark runs with the same model, prompt, state, and candidate fingerprint can replay cached assessments without another OpenAI request.

Reliability controls:

| Control | Env var | Default |
|---|---|---:|
| Enable assessment cache | `OPENAI_CANDIDATE_ASSESSMENT_CACHE` | `1` |
| Cache path | `OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH` | `traces/openai-candidate-assessment-cache.json` |
| Candidate-assessment pacing | `OPENAI_CANDIDATE_ASSESSMENT_MIN_INTERVAL_MS` | `65000` for `gpt-5.2` |
| Defer rate-limited candidate instead of model-erroring | `OPENAI_CANDIDATE_ASSESSMENT_DEFER_RATE_LIMIT` | `1` |
| Optional fresh assessments per regime | `OPENAI_CANDIDATE_ASSESSMENT_MAX_PER_REGIME` | blank |

Cached smoke commands:

```bash
cd agent
rm -f traces/openai-candidate-assessment-cache-smoke.json

OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-smoke.json \
OPENAI_BENCHMARK_MAX_RETRIES=0 \
npm run eval:synchronized:live -- \
  evals/live-candidate-assessment-smoke.json \
  traces/live-candidate-assessment-smoke-openai-cached-first.json

OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-smoke.json \
OPENAI_BENCHMARK_MAX_RETRIES=0 \
npm run eval:synchronized:live -- \
  evals/live-candidate-assessment-smoke.json \
  traces/live-candidate-assessment-smoke-openai-cached-replay.json
```

Cached smoke results:

| Run | Candidate events | Assessed | Cache hits | Cache misses | Rate-limit skips | Model errors |
|---|---:|---:|---:|---:|---:|---:|
| First cached smoke | 2 | 1 | 0 | 1 | 1 | 0 |
| Final cached replay | 2 | 2 | 2 | 0 | 0 | 0 |

The first cached smoke stored one successful assessment and deferred one rate-limited candidate without producing a model error. A follow-up run filled the second cache entry. The final replay then completed with two cache hits, zero OpenAI calls, zero provider skips, and zero model errors.

This changes the practical live-eval workflow: broad live runs can now be resumed and warmed incrementally instead of restarting from zero and repeatedly spending limited RPM on already-seen candidates.

## Tracked cache warming result

On June 8, 2026, the tracked four-regime fixture was warmed using one stable cache path:

```bash
cd agent
OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-tracked.json \
OPENAI_CANDIDATE_ASSESSMENT_MAX_PER_REGIME=1 \
OPENAI_BENCHMARK_MAX_RETRIES=0 \
npm run eval:synchronized:live -- \
  evals/market-regimes.json \
  traces/synchronized-openai-candidate-assessment-warm-1.json
```

The same command was repeated through `warm-5`, then replayed without fresh calls:

```bash
OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-tracked.json \
OPENAI_BENCHMARK_MAX_RETRIES=0 \
npm run eval:synchronized:live -- \
  evals/market-regimes.json \
  traces/synchronized-openai-candidate-assessment-warm-final.json
```

Warming progression:

| Run | Assessed | Cache hits | Cache misses | Provider skips | Budget skips | Model errors | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| `warm-1` | 3/10 | 0 | 3 | 0 | 7 | 0 | Failed |
| `warm-2` | 6/10 | 3 | 3 | 0 | 4 | 0 | Failed |
| `warm-3` | 8/10 | 6 | 2 | 0 | 2 | 0 | Failed |
| `warm-4` | 9/10 | 8 | 1 | 0 | 1 | 0 | Passed |
| `warm-5` | 10/10 | 9 | 1 | 0 | 0 | 0 | Failed, exact tie |
| `warm-final` | 10/10 | 10 | 0 | 0 | 0 | 0 | Failed, exact tie |

Final tracked replay:

| Metric | OpenAI candidate critic | Deterministic ensemble | DCA |
|---|---:|---:|---:|
| Average net ROI | +91 bps | +91 bps | +54 bps |
| Average composite score | +66 bps | +66 bps | -50 bps |
| Worst drawdown | -97 bps | -97 bps | -314 bps |
| Candidate events | 10 | n/a | n/a |
| Candidates assessed | 10 | n/a | n/a |
| Approvals | 10 | n/a | n/a |
| Vetoes | 0 | n/a | n/a |
| Cache hits | 10 | n/a | n/a |
| Cache misses | 0 | n/a | n/a |
| Provider skips | 0 | n/a | n/a |
| Budget skips | 0 | n/a | n/a |
| Model errors | 0 | n/a | n/a |

The operational goal is now achieved: the tracked live candidate-assessment benchmark can replay completely with no provider skips and no model errors.

The model-quality result is also clear: OpenAI approved every deterministic candidate. That is safe and schema-valid, but it does not add alpha over the deterministic ensemble on this fixture. The final replay exactly ties the deterministic ensemble because the critic did not veto or modify any candidate.

## Interpretation

The synchronized benchmark is now strong enough to support the project claim that the guarded ensemble beats simple human baselines under repeatable, cost-aware conditions.

The current AI-assisted runner beats DCA, buy-and-hold, mean-reversion, and usually momentum across held-out paths. It also has much lower drawdown than DCA because it avoids repeated buying during confirmed downtrends.

The important honest result is that offline AI-assisted equals the deterministic ensemble, and the warmed tracked live OpenAI replay also equals the deterministic ensemble. The live model did not hallucinate, produce invalid vetoes, or fail schema validation. It approved all valid deterministic candidates.

The cache/defer/budget scheduler now addresses the operational failure mode. The next model-side work should not be more cache warming; it should test whether the critic can actually distinguish safe candidates from risky, stale, regime-conflicted, or low-edge candidates.

## Artifacts

- `agent/traces/synchronized-benchmark.json`
- `agent/traces/synchronized-heldout-20260607.json`
- `agent/traces/synchronized-heldout-20260608.json`
- `agent/traces/synchronized-heldout-99999999.json`
- `agent/traces/live-candidate-assessment-smoke-offline.json`
- `agent/traces/live-candidate-assessment-smoke-openai.json`
- `agent/traces/live-candidate-assessment-smoke-openai-cached-first.json`
- `agent/traces/live-candidate-assessment-smoke-openai-cached-second.json`
- `agent/traces/live-candidate-assessment-smoke-openai-cached-replay.json`
- `agent/traces/openai-candidate-assessment-cache-smoke.json`
- `agent/traces/synchronized-openai-candidate-assessment.json`
- `agent/traces/openai-candidate-assessment-cache-tracked.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-1.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-2.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-3.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-4.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-5.json`
- `agent/traces/synchronized-openai-candidate-assessment-warm-final.json`

## Verification

```bash
cd agent
npx tsc --noEmit
npm test
npm run eval:synchronized -- evals/market-regimes.json traces/synchronized-benchmark.json
npm run eval:synchronized -- evals/generated/market-paths-held-out.json traces/synchronized-heldout-20260607.json
npm run eval:synchronized -- evals/gen-20260608/market-paths-held-out.json traces/synchronized-heldout-20260608.json
npm run eval:synchronized -- evals/gen-99999999/market-paths-held-out.json traces/synchronized-heldout-99999999.json
npm run eval:synchronized:live -- evals/live-candidate-assessment-smoke.json traces/live-candidate-assessment-smoke-openai.json
OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-smoke.json npm run eval:synchronized:live -- evals/live-candidate-assessment-smoke.json traces/live-candidate-assessment-smoke-openai-cached-replay.json
OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH=traces/openai-candidate-assessment-cache-tracked.json npm run eval:synchronized:live -- evals/market-regimes.json traces/synchronized-openai-candidate-assessment-warm-final.json
```

Verification status:

- TypeScript compile: passed.
- Full agent test suite: 42 files, 202 tests passed.
- Synchronized tracked fixture: passed with 0 model errors.
- Three 100-path held-out fixture runs: passed with 0 model errors.
- Live OpenAI smoke fixture: passed with 0 model errors.
- Live tracked fixture: completed artifact generation but failed `ok` because rate limits produced 5 model errors.
- Cached live replay smoke: passed with 2 cache hits, 0 cache misses, 0 provider skips, and 0 model errors.
- Warmed tracked live replay: passed with 10 cache hits, 0 cache misses, 0 provider skips, 0 budget skips, and 0 model errors.

## Recommended next slice

Build an adversarial live candidate-critic eval:

1. Generate candidate-assessment cases that include safe candidates, stale candidates, impossible sells, low-edge candidates, regime conflicts, and tail-risk examples.
2. Reuse the same `assess_trade_candidate` schema and cache.
3. Score approval precision and veto recall separately from PnL.
4. Only claim model-side value if OpenAI approves safe candidates while vetoing the adversarial ones with valid evidence.
5. After that, run a small live held-out subset.
