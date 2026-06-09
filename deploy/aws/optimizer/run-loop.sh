#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
source "$ROOT/deploy/aws/optimizer/controller.sh"

ALLOWED_PATH="agent/src/strategies/ensemble.ts"
MODEL="${OPTIMIZER_MODEL:-gpt-5.5}"
MAX_ITERATIONS="${OPTIMIZER_MAX_ITERATIONS:-3}"
STOP_AFTER_REJECTIONS="${OPTIMIZER_STOP_AFTER_REJECTIONS:-2}"
DRY_RUN="${OPTIMIZER_DRY_RUN:-0}"
RUN_ID="${OPTIMIZER_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${CODEBUILD_BUILD_NUMBER:-local}}"
ARTIFACT_DIR="$ROOT/optimizer-artifacts/$RUN_ID"
LEDGER="$ARTIFACT_DIR/iterations.jsonl"
HISTORY="$ARTIFACT_DIR/history.md"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mantle-optimizer.XXXXXX")"
TEMP_REF="refs/optimizer/$RUN_ID/best"

mkdir -p "$ARTIFACT_DIR"
printf '# Candidate history\n\n' >"$HISTORY"

cleanup() {
  rm -rf "$TMP_ROOT"
  git worktree prune >/dev/null 2>&1 || true
  git update-ref -d "$TEMP_REF" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "[optimizer] $*" >&2
  exit 1
}

require_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer"
}

require_integer OPTIMIZER_MAX_ITERATIONS "$MAX_ITERATIONS"
require_integer OPTIMIZER_STOP_AFTER_REJECTIONS "$STOP_AFTER_REJECTIONS"

if [[ ! -x "$ROOT/agent/node_modules/.bin/tsx" ]]; then
  fail "agent dependencies are missing; run cd agent && npm ci"
fi

run_verification() {
  local workspace="$1"
  local log_path="$2"
  (
    cd "$workspace/agent"
    npm test
    npm run build
  ) >"$log_path" 2>&1
}

run_suite() {
  local workspace="$1"
  local phase="$2"
  local output_path="$3"
  local log_path="$4"
  (
    cd "$workspace/agent"
    npm run eval:strategy-suite -- "--phase=$phase" "--output=$output_path"
  ) >"$log_path" 2>&1
}

run_gate() {
  local workspace="$1"
  local baseline_path="$2"
  local candidate_path="$3"
  local output_path="$4"
  (
    cd "$workspace/agent"
    ./node_modules/.bin/tsx \
      src/strategyOptimizationGate.ts \
      "$baseline_path" \
      "$candidate_path"
  ) >"$output_path"
}

append_ledger() {
  local iteration="$1"
  local status="$2"
  local detail="$3"
  local result_path="${4:-}"
  local gate_path="${5:-}"
  node - "$LEDGER" "$iteration" "$status" "$detail" "$result_path" "$gate_path" <<'NODE'
const fs = require("node:fs");
const [ledger, iteration, status, detail, resultPath, gatePath] = process.argv.slice(2);
const readJson = (file) => {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const entry = {
  recordedAt: new Date().toISOString(),
  iteration: Number(iteration),
  status,
  detail,
  codex: readJson(resultPath),
  gate: readJson(gatePath),
};
fs.appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
NODE
}

report_summary() {
  local report_path="$1"
  node - "$report_path" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = report.fixtures
  .map((fixture) =>
    `${fixture.fixture}: ROI ${fixture.aiAverageNetRoiBps} bps, composite ${fixture.aiAverageCompositeScoreBps} bps, drawdown ${fixture.aiWorstDrawdownBps} bps`,
  )
  .join("\n");
process.stdout.write(
  `Aggregate ROI: ${report.aggregate.aiAverageNetRoiBps} bps\n` +
    `Aggregate composite: ${report.aggregate.aiAverageCompositeScoreBps} bps\n` +
    `Worst drawdown: ${report.aggregate.aiWorstDrawdownBps} bps\n` +
    `DCA edge: ${report.aggregate.aiAverageEdgeByComparatorBps.dca} bps\n` +
    `Momentum edge: ${report.aggregate.aiAverageEdgeByComparatorBps.momentum} bps\n` +
    `DCA wins: ${report.aggregate.aiWinsByComparator.dca}/${report.totalRegimes}\n` +
    `Momentum wins: ${report.aggregate.aiWinsByComparator.momentum}/${report.totalRegimes}\n` +
    `${rows}\n`,
);
NODE
}

write_run_summary() {
  local status="$1"
  local original_commit="$2"
  local best_commit="$3"
  local development_report="$4"
  local heldout_report="${5:-}"
  local heldout_gate="${6:-}"
  node - \
    "$ARTIFACT_DIR/run-summary.json" \
    "$status" \
    "$RUN_ID" \
    "$MODEL" \
    "$original_commit" \
    "$best_commit" \
    "$development_report" \
    "$heldout_report" \
    "$heldout_gate" <<'NODE'
const fs = require("node:fs");
const [
  output,
  status,
  runId,
  model,
  originalCommit,
  bestCommit,
  developmentPath,
  heldoutPath,
  heldoutGatePath,
] = process.argv.slice(2);
const readJson = (file) =>
  file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runId,
  status,
  model,
  originalCommit,
  bestDevelopmentCommit: bestCommit,
  changed: originalCommit !== bestCommit,
  development: readJson(developmentPath),
  heldout: readJson(heldoutPath),
  heldoutGate: readJson(heldoutGatePath),
};
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
NODE
}

echo "[optimizer] run $RUN_ID"
echo "[optimizer] verifying current strategy"
run_verification "$ROOT" "$ARTIFACT_DIR/baseline-verification.log" ||
  fail "baseline tests or build failed; see $ARTIFACT_DIR/baseline-verification.log"

ORIGINAL_COMMIT="$(git rev-parse HEAD)"
BASELINE_DEVELOPMENT="$ARTIFACT_DIR/baseline-development.json"
run_suite \
  "$ROOT" \
  development \
  "$BASELINE_DEVELOPMENT" \
  "$ARTIFACT_DIR/baseline-development.log" ||
  fail "development baseline failed"

if [[ "$DRY_RUN" == "1" ]]; then
  BASELINE_HELDOUT="$ARTIFACT_DIR/baseline-heldout.json"
  run_suite \
    "$ROOT" \
    heldout \
    "$BASELINE_HELDOUT" \
    "$ARTIFACT_DIR/baseline-heldout.log" ||
    fail "held-out baseline failed"
  write_run_summary \
    "dry-run-complete" \
    "$ORIGINAL_COMMIT" \
    "$ORIGINAL_COMMIT" \
    "$BASELINE_DEVELOPMENT" \
    "$BASELINE_HELDOUT"
  echo "[optimizer] dry run complete: $ARTIFACT_DIR"
  exit 0
fi

[[ -z "$(git status --porcelain)" ]] ||
  fail "full optimization requires a clean Git checkout"
command -v codex >/dev/null 2>&1 || fail "codex CLI is not installed"
KEY_FILE="${OPTIMIZER_CODEX_KEY_FILE:-}"
SECRET_ARN="${OPTIMIZER_CODEX_SECRET_ARN:-}"
if [[ -z "$KEY_FILE" && -z "$SECRET_ARN" ]]; then
  fail "set OPTIMIZER_CODEX_KEY_FILE or OPTIMIZER_CODEX_SECRET_ARN"
fi
if [[ -n "$KEY_FILE" && ! -s "$KEY_FILE" ]]; then
  fail "OPTIMIZER_CODEX_KEY_FILE must point to a non-empty API key file"
fi
if [[ -n "$SECRET_ARN" ]]; then
  command -v aws >/dev/null 2>&1 ||
    fail "aws CLI is required when OPTIMIZER_CODEX_SECRET_ARN is set"
fi

read_codex_key() {
  if [[ -n "$KEY_FILE" ]]; then
    cat "$KEY_FILE"
    return
  fi
  aws secretsmanager get-secret-value \
    --secret-id "$SECRET_ARN" \
    --query SecretString \
    --output text |
    node -e '
      let source = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { source += chunk; });
      process.stdin.on("end", () => {
        const key = JSON.parse(source).CODEX_API_KEY;
        if (!key || typeof key !== "string") {
          throw new Error("CODEX_API_KEY is missing from the optimizer secret");
        }
        process.stdout.write(key);
      });
    '
}

BEST_COMMIT="$ORIGINAL_COMMIT"
BEST_DEVELOPMENT="$BASELINE_DEVELOPMENT"
CONSECUTIVE_REJECTIONS=0
git update-ref "$TEMP_REF" "$BEST_COMMIT"

for ((iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1)); do
  echo "[optimizer] iteration $iteration/$MAX_ITERATIONS"
  PROPOSAL_DIR="$TMP_ROOT/proposal-$iteration"
  EVALUATION_DIR="$TMP_ROOT/evaluation-$iteration"
  mkdir -p "$PROPOSAL_DIR"

  git archive "$BEST_COMMIT" | tar -x -C "$PROPOSAL_DIR"
  find "$PROPOSAL_DIR/agent/evals" -type f -name '*held-out*' -delete
  (
    cd "$PROPOSAL_DIR"
    git init -q
    git add -A
    git -c user.name=mantle-optimizer -c user.email=optimizer@local commit -qm "optimizer baseline"
  )
  PROPOSAL_BASE="$(git -C "$PROPOSAL_DIR" rev-parse HEAD)"
  ln -s "$ROOT/agent/node_modules" "$PROPOSAL_DIR/agent/node_modules"

  PROMPT_PATH="$ARTIFACT_DIR/iteration-$iteration-prompt.md"
  {
    cat "$ROOT/deploy/aws/optimizer/codex-prompt.md"
    printf '\n## Current accepted development score\n\n```text\n'
    report_summary "$BEST_DEVELOPMENT"
    printf '```\n\n## Prior candidate outcomes\n\n'
    cat "$HISTORY"
  } >"$PROMPT_PATH"

  RESULT_IN_WORKSPACE="$PROPOSAL_DIR/.codex-result.json"
  RESULT_PATH="$ARTIFACT_DIR/iteration-$iteration-codex-result.json"
  EVENTS_PATH="$ARTIFACT_DIR/iteration-$iteration-codex-events.jsonl"
  CODEX_LOG="$ARTIFACT_DIR/iteration-$iteration-codex.stderr.log"

  build_optimizer_codex_args \
    "$ROOT" \
    "$PROPOSAL_DIR" \
    "$MODEL" \
    "$RESULT_IN_WORKSPACE"

  if CODEX_API_KEY="$(read_codex_key)" codex "${OPTIMIZER_CODEX_ARGS[@]}" \
    "$(<"$PROMPT_PATH")" \
    >"$EVENTS_PATH" \
    2>"$CODEX_LOG"; then
    CODEX_STATUS=0
  else
    CODEX_STATUS=$?
  fi

  if [[ -f "$RESULT_IN_WORKSPACE" ]]; then
    cp "$RESULT_IN_WORKSPACE" "$RESULT_PATH"
    rm -f "$RESULT_IN_WORKSPACE"
  fi

  if [[ "$CODEX_STATUS" -ne 0 || ! -s "$RESULT_PATH" ]]; then
    FAILURE_DETAIL="$(optimizer_codex_failure_detail "$EVENTS_PATH" "$CODEX_STATUS")"
    append_ledger "$iteration" "codex-failed" "$FAILURE_DETAIL" "$RESULT_PATH"
    printf -- '- Iteration %s: Codex failed: %s\n' \
      "$iteration" \
      "$FAILURE_DETAIL" >>"$HISTORY"
    CONSECUTIVE_REJECTIONS=$((CONSECUTIVE_REJECTIONS + 1))
    if optimizer_codex_failure_is_nonretryable "$EVENTS_PATH"; then
      echo "[optimizer] stopping after non-retryable Codex request failure" >&2
      break
    fi
    [[ "$CONSECUTIVE_REJECTIONS" -lt "$STOP_AFTER_REJECTIONS" ]] || break
    continue
  fi

  CHANGED_PATHS="$(
    {
      git -C "$PROPOSAL_DIR" diff --name-only "$PROPOSAL_BASE"
      git -C "$PROPOSAL_DIR" ls-files --others --exclude-standard
    } | sort -u
  )"
  if [[ "$CHANGED_PATHS" != "$ALLOWED_PATH" ]]; then
    append_ledger \
      "$iteration" \
      "scope-rejected" \
      "changed paths were: ${CHANGED_PATHS:-none}" \
      "$RESULT_PATH"
    printf -- '- Iteration %s: rejected for changing `%s`.\n' \
      "$iteration" \
      "${CHANGED_PATHS:-no files}" >>"$HISTORY"
    CONSECUTIVE_REJECTIONS=$((CONSECUTIVE_REJECTIONS + 1))
    [[ "$CONSECUTIVE_REJECTIONS" -lt "$STOP_AFTER_REJECTIONS" ]] || break
    continue
  fi

  CANDIDATE_REPORT="$ARTIFACT_DIR/iteration-$iteration-development.json"
  CANDIDATE_LOG="$ARTIFACT_DIR/iteration-$iteration-verification.log"
  if ! run_verification "$PROPOSAL_DIR" "$CANDIDATE_LOG"; then
    append_ledger "$iteration" "verification-rejected" "tests or build failed" "$RESULT_PATH"
    printf -- '- Iteration %s: rejected because tests or build failed.\n' "$iteration" >>"$HISTORY"
    CONSECUTIVE_REJECTIONS=$((CONSECUTIVE_REJECTIONS + 1))
    [[ "$CONSECUTIVE_REJECTIONS" -lt "$STOP_AFTER_REJECTIONS" ]] || break
    continue
  fi
  if ! run_suite \
    "$PROPOSAL_DIR" \
    development \
    "$CANDIDATE_REPORT" \
    "$ARTIFACT_DIR/iteration-$iteration-development.log"; then
    append_ledger "$iteration" "eval-rejected" "development suite failed" "$RESULT_PATH"
    printf -- '- Iteration %s: rejected because the development eval failed.\n' "$iteration" >>"$HISTORY"
    CONSECUTIVE_REJECTIONS=$((CONSECUTIVE_REJECTIONS + 1))
    [[ "$CONSECUTIVE_REJECTIONS" -lt "$STOP_AFTER_REJECTIONS" ]] || break
    continue
  fi

  GATE_PATH="$ARTIFACT_DIR/iteration-$iteration-development-gate.json"
  if ! run_gate "$PROPOSAL_DIR" "$BEST_DEVELOPMENT" "$CANDIDATE_REPORT" "$GATE_PATH"; then
    append_ledger "$iteration" "gate-rejected" "development promotion gate failed" "$RESULT_PATH" "$GATE_PATH"
    printf -- '- Iteration %s: rejected by the development promotion gate. See `%s`.\n' \
      "$iteration" \
      "$(basename "$GATE_PATH")" >>"$HISTORY"
    CONSECUTIVE_REJECTIONS=$((CONSECUTIVE_REJECTIONS + 1))
    [[ "$CONSECUTIVE_REJECTIONS" -lt "$STOP_AFTER_REJECTIONS" ]] || break
    continue
  fi

  git worktree add --detach "$EVALUATION_DIR" "$BEST_COMMIT" >/dev/null
  cp "$PROPOSAL_DIR/$ALLOWED_PATH" "$EVALUATION_DIR/$ALLOWED_PATH"
  (
    cd "$EVALUATION_DIR"
    git add "$ALLOWED_PATH"
    git \
      -c user.name=mantle-optimizer \
      -c user.email=optimizer@local \
      commit -qm "optimizer: accept strategy iteration $iteration"
  )
  BEST_COMMIT="$(git -C "$EVALUATION_DIR" rev-parse HEAD)"
  git update-ref "$TEMP_REF" "$BEST_COMMIT"
  BEST_DEVELOPMENT="$CANDIDATE_REPORT"
  append_ledger "$iteration" "development-accepted" "candidate became the current best" "$RESULT_PATH" "$GATE_PATH"
  printf -- '- Iteration %s: accepted as the current development winner.\n' "$iteration" >>"$HISTORY"
  CONSECUTIVE_REJECTIONS=0
  git worktree remove --force "$EVALUATION_DIR"
done

BEST_PATCH="$ARTIFACT_DIR/best-development.patch"
git diff --binary "$ORIGINAL_COMMIT" "$BEST_COMMIT" -- "$ALLOWED_PATH" >"$BEST_PATCH"

echo "[optimizer] running held-out gate after proposal generation is complete"
BASELINE_HELDOUT="$ARTIFACT_DIR/baseline-heldout.json"
run_suite \
  "$ROOT" \
  heldout \
  "$BASELINE_HELDOUT" \
  "$ARTIFACT_DIR/baseline-heldout.log" ||
  fail "held-out baseline failed"

FINAL_HELDOUT="$ARTIFACT_DIR/final-heldout.json"
FINAL_GATE="$ARTIFACT_DIR/final-heldout-gate.json"
FINAL_STATUS="no-development-winner"

if [[ "$BEST_COMMIT" != "$ORIGINAL_COMMIT" ]]; then
  FINAL_DIR="$TMP_ROOT/final"
  git worktree add --detach "$FINAL_DIR" "$BEST_COMMIT" >/dev/null
  ln -s "$ROOT/agent/node_modules" "$FINAL_DIR/agent/node_modules"
  if run_suite \
    "$FINAL_DIR" \
    heldout \
    "$FINAL_HELDOUT" \
    "$ARTIFACT_DIR/final-heldout.log" &&
    run_gate "$FINAL_DIR" "$BASELINE_HELDOUT" "$FINAL_HELDOUT" "$FINAL_GATE"; then
    cp "$BEST_PATCH" "$ARTIFACT_DIR/winner.patch"
    FINAL_STATUS="heldout-approved"
  else
    FINAL_STATUS="heldout-rejected"
  fi
  git worktree remove --force "$FINAL_DIR"
else
  cp "$BASELINE_HELDOUT" "$FINAL_HELDOUT"
fi

write_run_summary \
  "$FINAL_STATUS" \
  "$ORIGINAL_COMMIT" \
  "$BEST_COMMIT" \
  "$BEST_DEVELOPMENT" \
  "$FINAL_HELDOUT" \
  "$FINAL_GATE"

echo "[optimizer] complete with status $FINAL_STATUS"
echo "[optimizer] artifacts: $ARTIFACT_DIR"
