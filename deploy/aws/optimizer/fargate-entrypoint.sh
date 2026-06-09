#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

: "${OPTIMIZER_ARTIFACT_BUCKET:?OPTIMIZER_ARTIFACT_BUCKET is required}"
: "${OPTIMIZER_CODEX_SECRET_ARN:?OPTIMIZER_CODEX_SECRET_ARN is required}"

RUN_ID="${OPTIMIZER_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-fargate}"
export OPTIMIZER_RUN_ID="$RUN_ID"

status=0
bash deploy/aws/optimizer/run-loop.sh || status=$?

artifact_dir="$ROOT/optimizer-artifacts/$RUN_ID"
if [[ -d "$artifact_dir" ]]; then
  aws s3 cp \
    "$artifact_dir" \
    "s3://$OPTIMIZER_ARTIFACT_BUCKET/fargate/$RUN_ID/" \
    --recursive
fi

exit "$status"
