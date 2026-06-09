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
MAX_ITERATIONS="${OPTIMIZER_MAX_ITERATIONS:-3}"
STOP_AFTER_REJECTIONS="${OPTIMIZER_STOP_AFTER_REJECTIONS:-2}"
DRY_RUN="${OPTIMIZER_DRY_RUN:-0}"
MODEL="${OPTIMIZER_MODEL:-gpt-5.4-mini}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

PROJECT_NAME="$(
  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='ProjectName'].OutputValue | [0]" \
    --output text
)"

BUILD_ID="$(
  aws_cli codebuild start-build \
    --project-name "$PROJECT_NAME" \
    --environment-variables-override \
      name=OPTIMIZER_MAX_ITERATIONS,value="$MAX_ITERATIONS",type=PLAINTEXT \
      name=OPTIMIZER_STOP_AFTER_REJECTIONS,value="$STOP_AFTER_REJECTIONS",type=PLAINTEXT \
      name=OPTIMIZER_DRY_RUN,value="$DRY_RUN",type=PLAINTEXT \
      name=OPTIMIZER_MODEL,value="$MODEL",type=PLAINTEXT \
    --query "build.id" \
    --output text
)"

echo "Started optimizer build: $BUILD_ID"
echo "Monitor: AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION ./deploy/aws/optimizer/status.sh"
