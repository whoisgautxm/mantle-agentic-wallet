#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export AWS_PROFILE="${AWS_PROFILE:-mantle}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

APP_NAME="${APP_NAME:-mantle-agent-wallet}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
STACK_NAME="${OPTIMIZER_STACK_NAME:-${APP_NAME}-${ENVIRONMENT}-optimizer}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

output() {
  local key="$1"
  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

PROJECT_NAME="$(output ProjectName)"
ARTIFACT_BUCKET="$(output ArtifactBucket)"
LOG_GROUP="$(output LogGroup)"
BUILD_ID="${BUILD_ID:-$(
  aws_cli codebuild list-builds-for-project \
    --project-name "$PROJECT_NAME" \
    --sort-order DESCENDING \
    --query "ids[0]" \
    --output text
)}"

if [[ -z "$BUILD_ID" || "$BUILD_ID" == "None" ]]; then
  echo "No optimizer builds found for $PROJECT_NAME"
  exit 0
fi

aws_cli codebuild batch-get-builds \
  --ids "$BUILD_ID" \
  --query "builds[0].{id:id,status:buildStatus,started:startTime,finished:endTime,minutes:buildComplete,artifact:artifacts.location,log:logs.deepLink}" \
  --output table

echo "Artifact bucket: s3://$ARTIFACT_BUCKET/runs/"
echo "CloudWatch log group: $LOG_GROUP"

if [[ "${FOLLOW:-0}" == "1" ]]; then
  aws_cli logs tail "$LOG_GROUP" --since 2h --follow
elif [[ "${TAIL_LOGS:-1}" == "1" ]]; then
  aws_cli logs tail "$LOG_GROUP" --since 2h
fi
