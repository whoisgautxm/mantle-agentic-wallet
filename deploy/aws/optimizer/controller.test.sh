#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/deploy/aws/optimizer/controller.sh"

fail() {
  echo "[optimizer-controller-test] $*" >&2
  exit 1
}

build_optimizer_codex_args "$ROOT" "/tmp/proposal" "gpt-5.5" "/tmp/result.json"

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq "model_instructions_file=\"$ROOT/deploy/aws/optimizer/codex-base-instructions.md\"" ||
  fail "Codex must use the compact optimizer instructions"

printf '%s\n' "${OPTIMIZER_CODEX_ARGS[@]}" |
  grep -Fq 'model_reasoning_effort="low"' ||
  fail "Codex must use bounded reasoning effort"

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

echo "[optimizer-controller-test] passed"
