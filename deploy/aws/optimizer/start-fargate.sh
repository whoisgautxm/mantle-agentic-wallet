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
DRY_RUN="${OPTIMIZER_DRY_RUN:-0}"
MAX_ITERATIONS="${OPTIMIZER_MAX_ITERATIONS:-3}"
STOP_AFTER_REJECTIONS="${OPTIMIZER_STOP_AFTER_REJECTIONS:-2}"
MODEL="${OPTIMIZER_MODEL:-gpt-5.4-mini}"
RUN_ID="${OPTIMIZER_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-fargate}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

resource_id() {
  local logical_id="$1"
  aws_cli cloudformation describe-stack-resource \
    --stack-name "$APP_STACK_NAME" \
    --logical-resource-id "$logical_id" \
    --query StackResourceDetail.PhysicalResourceId \
    --output text
}

TASK_DEFINITION="$(
  aws_cli cloudformation describe-stacks \
    --stack-name "$OPTIMIZER_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='TaskDefinitionArn'].OutputValue | [0]" \
    --output text
)"
CLUSTER_NAME="$(resource_id Cluster)"
SUBNET_A="$(resource_id PublicSubnetA)"
SUBNET_B="$(resource_id PublicSubnetB)"
SECURITY_GROUP="$(resource_id TaskSecurityGroup)"

OVERRIDES="$(
  node - \
    "$DRY_RUN" \
    "$MAX_ITERATIONS" \
    "$STOP_AFTER_REJECTIONS" \
    "$MODEL" \
    "$RUN_ID" <<'NODE'
const [dryRun, maxIterations, stopAfterRejections, model, runId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  containerOverrides: [{
    name: "optimizer",
    environment: [
      { name: "OPTIMIZER_DRY_RUN", value: dryRun },
      { name: "OPTIMIZER_MAX_ITERATIONS", value: maxIterations },
      { name: "OPTIMIZER_STOP_AFTER_REJECTIONS", value: stopAfterRejections },
      { name: "OPTIMIZER_MODEL", value: model },
      { name: "OPTIMIZER_RUN_ID", value: runId },
    ],
  }],
}));
NODE
)"

TASK_ARN="$(
  aws_cli ecs run-task \
    --cluster "$CLUSTER_NAME" \
    --task-definition "$TASK_DEFINITION" \
    --launch-type FARGATE \
    --platform-version LATEST \
    --count 1 \
    --network-configuration \
      "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
    --overrides "$OVERRIDES" \
    --started-by mantle-strategy-optimizer \
    --tags key=Project,value="$APP_NAME" key=Purpose,value=strategy-optimization \
    --query "tasks[0].taskArn" \
    --output text
)"

echo "Started optimizer task: $TASK_ARN"
echo "Run ID: $RUN_ID"
echo "Monitor: TASK_ARN=$TASK_ARN AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION ./deploy/aws/optimizer/status-fargate.sh"
