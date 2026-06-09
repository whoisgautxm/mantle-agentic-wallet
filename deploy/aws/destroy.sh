#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export AWS_PROFILE="${AWS_PROFILE:-mantle}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

APP_NAME="${APP_NAME:-mantle-agent-wallet}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
STACK_NAME="${STACK_NAME:-${APP_NAME}-${ENVIRONMENT}}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

echo "[destroy] deleting stack $STACK_NAME, including ECS, ALB, VPC, and EFS traces"
aws_cli cloudformation delete-stack --stack-name "$STACK_NAME"
aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
echo "[destroy] stack deleted; ECR images and Secrets Manager secret were retained"
