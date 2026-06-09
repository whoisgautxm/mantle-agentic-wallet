#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/deploy/aws/optimizer/controller.sh"

fail() {
  echo "[optimizer-controller-test] $*" >&2
  exit 1
}

grep -Fq 'MODEL="${OPTIMIZER_MODEL:-gpt-5.4-mini}"' \
  "$ROOT/deploy/aws/optimizer/run-loop.sh" ||
  fail "the optimizer must default to the throughput-safe model"

build_optimizer_codex_args "$ROOT" "/tmp/proposal" "gpt-5.5" "/tmp/result.json"

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq -- '--dangerously-bypass-approvals-and-sandbox' ||
  fail "isolated Fargate runs must not depend on unavailable user namespaces"

if printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" | grep -Fq -- '--sandbox'; then
  fail "Bubblewrap-backed sandbox flags are unsupported in Fargate"
fi

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq "model_instructions_file=\"$ROOT/deploy/aws/optimizer/codex-base-instructions.md\"" ||
  fail "Codex must use the compact optimizer instructions"

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq 'model_reasoning_effort="low"' ||
  fail "Codex must use bounded reasoning effort"

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq 'tool_output_token_limit=1500' ||
  fail "Codex tool output must stay below the low-tier TPM budget"

events="$(mktemp)"
trap 'rm -f "$events"' EXIT
cat >"$events" <<'EOF'
{"type":"error","message":"Reconnecting..."}
{"type":"turn.failed","error":{"message":"Request too large for gpt-5.5 on tokens per min (TPM): Limit 10000, Requested 12590."}}
EOF

detail="$(optimizer_codex_failure_detail "$events" 1)"
[[ "$detail" == *"TPM"* && "$detail" == *"Requested 12590"* ]] ||
  fail "failure detail did not preserve the terminal Codex error"

optimizer_codex_failure_is_nonretryable "$events" ||
  fail "oversized TPM requests must be classified as non-retryable"

fixture="$(mktemp -d)"
mkdir -p "$fixture/root/agent/node_modules" "$fixture/proposal/agent"
optimizer_link_agent_dependencies "$fixture/root" "$fixture/proposal"
(
  cd "$fixture/proposal"
  git init -q
  git add -A
  git -c user.name=test -c user.email=test@local commit -qm baseline
)
[[ -z "$(git -C "$fixture/proposal" status --porcelain)" ]] ||
  fail "the controller dependency link must be part of the proposal baseline"
rm -rf "$fixture"

echo "[optimizer-controller-test] passed"
