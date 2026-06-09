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
CLUSTER_NAME="${APP_NAME}-${ENVIRONMENT}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

DASHBOARD_URL="$(
  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue | [0]" \
    --output text
)"

aws_cli ecs describe-services \
  --cluster "$CLUSTER_NAME" \
  --services \
    "${APP_NAME}-${ENVIRONMENT}-web" \
    "${APP_NAME}-${ENVIRONMENT}-agent" \
    "${APP_NAME}-${ENVIRONMENT}-keeper" \
    "${APP_NAME}-${ENVIRONMENT}-baseline" \
  --query "services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,status:status}" \
  --output table

curl --fail --silent --show-error "$DASHBOARD_URL" >/dev/null
echo "Dashboard healthy: $DASHBOARD_URL"
