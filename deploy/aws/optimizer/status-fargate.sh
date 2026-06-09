#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export AWS_PROFILE="${AWS_PROFILE:-mantle}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

APP_NAME="${APP_NAME:-mantle-agent-wallet}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
APP_STACK_NAME="${STACK_NAME:-${APP_NAME}-${ENVIRONMENT}}"
OPTIMIZER_STACK_NAME="${OPTIMIZER_FARGATE_STACK_NAME:-${APP_NAME}-${ENVIRONMENT}-optimizer-fargate}"

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
    --stack-name "$OPTIMIZER_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

CLUSTER_NAME="$(
  aws_cli cloudformation describe-stack-resource \
    --stack-name "$APP_STACK_NAME" \
    --logical-resource-id Cluster \
    --query StackResourceDetail.PhysicalResourceId \
    --output text
)"
TASK_DEFINITION="$(output TaskDefinitionArn)"
LOG_GROUP="$(output LogGroup)"
ARTIFACT_BUCKET="$(output ArtifactBucket)"
FAMILY_REVISION="${TASK_DEFINITION##*/}"
TASK_FAMILY="${FAMILY_REVISION%:*}"

if [[ -z "${TASK_ARN:-}" ]]; then
  TASK_ARN="$(
    aws_cli ecs list-tasks \
      --cluster "$CLUSTER_NAME" \
      --family "$TASK_FAMILY" \
      --desired-status RUNNING \
      --query "taskArns[0]" \
      --output text
  )"
fi

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "Set TASK_ARN to the value printed by start-fargate.sh"
  exit 1
fi

if [[ "${WAIT:-0}" == "1" ]]; then
  aws_cli ecs wait tasks-stopped --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN"
fi

aws_cli ecs describe-tasks \
  --cluster "$CLUSTER_NAME" \
  --tasks "$TASK_ARN" \
  --query "tasks[0].{status:lastStatus,desired:desiredStatus,created:createdAt,started:startedAt,stopped:stoppedAt,reason:stoppedReason,exit:containers[0].exitCode,containerReason:containers[0].reason}" \
  --output table

echo "Artifacts: s3://$ARTIFACT_BUCKET/fargate/"
echo "Logs: $LOG_GROUP"

if [[ "${FOLLOW:-0}" == "1" ]]; then
  aws_cli logs tail "$LOG_GROUP" --since 2h --follow
elif [[ "${TAIL_LOGS:-1}" == "1" ]]; then
  aws_cli logs tail "$LOG_GROUP" --since 2h
fi
