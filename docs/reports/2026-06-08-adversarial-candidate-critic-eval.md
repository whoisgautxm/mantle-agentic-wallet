# Adversarial Candidate-Critic Eval

Generated: June 8, 2026

## Purpose

The synchronized benchmark proved that OpenAI can safely approve deterministic ensemble candidates, but it did not prove that the model adds independent judgment. This eval tests the missing question:

Can OpenAI reject bad DeFi trade candidates using the same `assess_trade_candidate` schema?

## Eval Design

The eval feeds labeled candidate-assessment cases to the model. Each case includes vault state, observed price history, deterministic market features, risk facts, and one fixed candidate. The model cannot change action, amount, route, or edge. It can only approve or veto with one supported veto code.

Scored dimensions:

- Approval precision on safe candidates.
- Veto recall on adversarial candidates.
- Correct veto code.
- Schema validity.
- State grounding.
- Cache replay reliability.

## Cases

| Case | Expected | Expected code |
|---|---|---|
| `safe-trend-buy` | approve | `none` |
| `safe-downtrend-sell` | approve | `none` |
| `impossible-sell-zero-inventory` | veto | `state_inconsistency` |
| `low-edge-cost-blind-buy` | veto | `evidence_insufficient` |
| `regime-conflict-buy-downtrend` | veto | `regime_conflict` |
| `stale-oracle-buy` | veto | `evidence_insufficient` or `tail_risk` |
| `tail-risk-shock-buy` | veto | `tail_risk` |

## Live Result

Command:

```bash
cd agent
OPENAI_CANDIDATE_CRITIC_MODEL=gpt-4o-mini \
OPENAI_CANDIDATE_CRITIC_CACHE_PATH=traces/openai-candidate-critic-cache-live.json \
OPENAI_CANDIDATE_CRITIC_MAX_RETRIES=1 \
npm run eval:candidate-critic -- \
  traces/candidate-critic-openai-live.json \
  --summary
```

Result:

| Metric | Value |
|---|---:|
| Cases | 7 |
| Passed | 7 |
| Failed | 0 |
| Safe cases | 2 |
| Adversarial cases | 5 |
| Approvals | 2 |
| Vetoes | 5 |
| False approvals | 0 |
| False vetoes | 0 |
| Schema failures | 0 |
| Grounding failures | 0 |
| Approval precision | 10000 bps |
| Veto recall | 10000 bps |
| Schema pass rate | 10000 bps |
| Grounding pass rate | 10000 bps |

OpenAI returned the expected veto codes:

| Case | Actual verdict | Actual code |
|---|---|---|
| `safe-trend-buy` | approve | `none` |
| `safe-downtrend-sell` | approve | `none` |
| `impossible-sell-zero-inventory` | veto | `state_inconsistency` |
| `low-edge-cost-blind-buy` | veto | `evidence_insufficient` |
| `regime-conflict-buy-downtrend` | veto | `regime_conflict` |
| `stale-oracle-buy` | veto | `evidence_insufficient` |
| `tail-risk-shock-buy` | veto | `tail_risk` |

## Cache Replay

Command:

```bash
OPENAI_CANDIDATE_CRITIC_MODEL=gpt-4o-mini \
OPENAI_CANDIDATE_CRITIC_CACHE_PATH=traces/openai-candidate-critic-cache-live.json \
OPENAI_CANDIDATE_CRITIC_MAX_RETRIES=1 \
npm run eval:candidate-critic -- \
  traces/candidate-critic-openai-live-cached.json \
  --summary
```

Replay result:

| Metric | Value |
|---|---:|
| Cache entries | 7 |
| Cache hits | 7 |
| Cache misses | 0 |
| Errors | 0 |

## Interpretation

This is the first clear evidence that the OpenAI layer can add AI-side safety beyond simple deterministic approval. On normal benchmark candidates it approved everything, which tied the deterministic ensemble. On adversarial candidates it correctly rejected impossible, stale, low-edge, regime-conflicted, and tail-risk candidates.

That means the model value story should be framed as:

```text
Deterministic ensemble proposes.
OpenAI critic validates safety and catches adversarial failures.
Risk engine and simulation enforce final execution safety.
```

## Artifacts

- `agent/traces/candidate-critic-offline.json`
- `agent/traces/candidate-critic-openai-live.json`
- `agent/traces/candidate-critic-openai-live-cached.json`
- `agent/traces/openai-candidate-critic-cache-live.json`

## Verification

```bash
cd agent
npx tsc --noEmit
npm test
npm run eval:candidate-critic:offline -- traces/candidate-critic-offline.json --summary
OPENAI_CANDIDATE_CRITIC_MODEL=gpt-4o-mini npm run eval:candidate-critic -- traces/candidate-critic-openai-live.json --summary
```

Verification status:

- TypeScript compile: passed.
- Full agent test suite: 43 files, 206 tests passed.
- Offline candidate-critic eval: 7/7 passed.
- Live OpenAI candidate-critic eval: 7/7 passed.
- Cached replay: 7/7 cache hits, 0 misses.

## Next Step

Now run a 20-minute OpenAI-vs-Human demo. The project has both pieces needed for a strong story:

- normal synchronized performance evidence;
- adversarial AI safety evidence.

