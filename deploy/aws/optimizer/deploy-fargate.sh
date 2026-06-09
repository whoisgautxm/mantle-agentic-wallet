#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export AWS_PROFILE="${AWS_PROFILE:-mantle}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

APP_NAME="${APP_NAME:-mantle-agent-wallet}"
ENVIRONMENT="${ENVIRONMENT:-prod}"
STACK_NAME="${OPTIMIZER_FARGATE_STACK_NAME:-${APP_NAME}-${ENVIRONMENT}-optimizer-fargate}"
OPTIMIZER_SECRET_NAME="${OPTIMIZER_SECRET_NAME:-${APP_NAME}/optimizer}"
ECR_REPOSITORY="${OPTIMIZER_ECR_REPOSITORY:-mantle-agent-optimizer}"
CODEX_MODEL="${OPTIMIZER_MODEL:-gpt-5.4-mini}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.137.0}"
MAX_ITERATIONS="${OPTIMIZER_MAX_ITERATIONS:-3}"
STOP_AFTER_REJECTIONS="${OPTIMIZER_STOP_AFTER_REJECTIONS:-2}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}"

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

[[ -z "$(git status --porcelain)" ]] || {
  echo "[optimizer-fargate] commit changes before deployment" >&2
  exit 1
}

LOCAL_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(
  git ls-remote "$(git remote get-url origin)" "refs/heads/$(git branch --show-current)" |
    awk 'NR == 1 { print $1 }'
)"
[[ "$LOCAL_COMMIT" == "$REMOTE_COMMIT" ]] || {
  echo "[optimizer-fargate] local HEAD must be pushed before deployment" >&2
  exit 1
}

AWS_ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text)"
if ! aws_cli ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  aws_cli ecr create-repository \
    --repository-name "$ECR_REPOSITORY" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    --tags Key=Project,Value="$APP_NAME" Key=Environment,Value="$ENVIRONMENT" \
    >/dev/null
fi

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"
aws_cli ecr get-login-password |
  docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --build-arg "CODEX_CLI_VERSION=$CODEX_CLI_VERSION" \
  -f deploy/docker/Dockerfile.optimizer \
  -t "$IMAGE_URI" \
  --push \
  .

CODEX_SECRET_ARN="$(
  aws_cli secretsmanager describe-secret \
    --secret-id "$OPTIMIZER_SECRET_NAME" \
    --query ARN \
    --output text
)"

aws_cli cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file deploy/aws/optimizer/fargate-cloudformation.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags Project="$APP_NAME" Environment="$ENVIRONMENT" ManagedBy=codex \
  --parameter-overrides \
    AppName="$APP_NAME" \
    Environment="$ENVIRONMENT" \
    OptimizerImageUri="$IMAGE_URI" \
    CodexSecretArn="$CODEX_SECRET_ARN" \
    CodexModel="$CODEX_MODEL" \
    MaxIterations="$MAX_ITERATIONS" \
    StopAfterRejections="$STOP_AFTER_REJECTIONS"

aws_cli cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[].{key:OutputKey,value:OutputValue}" \
  --output table
