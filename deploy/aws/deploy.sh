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
SECRET_NAME="${SECRET_NAME:-${APP_NAME}/${ENVIRONMENT}}"
WEB_REPO="${WEB_REPO:-mantle-agent-web}"
WORKER_REPO="${WORKER_REPO:-mantle-agent-worker}"
OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.2}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}"
RUNTIME_DIR="$ROOT/deploy/aws/.runtime"
SECRET_FILE="$RUNTIME_DIR/secrets.production.json"

mkdir -p "$RUNTIME_DIR"
trap 'rm -f "$SECRET_FILE"' EXIT

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

ensure_repository() {
  local repository="$1"
  if ! aws_cli ecr describe-repositories --repository-names "$repository" >/dev/null 2>&1; then
    aws_cli ecr create-repository \
      --repository-name "$repository" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 \
      --tags Key=Project,Value="$APP_NAME" Key=Environment,Value="$ENVIRONMENT" \
      >/dev/null
  fi
}

echo "[deploy] validating AWS identity for profile $AWS_PROFILE in $AWS_REGION"
AWS_ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text)"
if [[ -z "$AWS_ACCOUNT_ID" || "$AWS_ACCOUNT_ID" == "None" ]]; then
  echo "[deploy] AWS account identity is unavailable" >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "[deploy] missing $ROOT/.env" >&2
  exit 1
fi

echo "[deploy] rendering Secrets Manager payload"
node "$ROOT/deploy/aws/render-secrets.mjs" "$ROOT/.env" "$SECRET_FILE"

echo "[deploy] creating ECR repositories when absent"
ensure_repository "$WEB_REPO"
ensure_repository "$WORKER_REPO"

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
WEB_IMAGE="${REGISTRY}/${WEB_REPO}:${IMAGE_TAG}"
WORKER_IMAGE="${REGISTRY}/${WORKER_REPO}:${IMAGE_TAG}"

echo "[deploy] authenticating Docker to ECR"
aws_cli ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

if [[ "${RUN_TESTS:-1}" == "1" ]]; then
  echo "[deploy] running release tests"
  (cd agent && npm test && npm run build)
  (cd web && npm test && npm run typecheck && npm run build)
fi

echo "[deploy] building and pushing web image $IMAGE_TAG"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  -f deploy/docker/Dockerfile.web \
  -t "$WEB_IMAGE" \
  --push \
  .

echo "[deploy] building and pushing worker image $IMAGE_TAG"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  -f deploy/docker/Dockerfile.agent \
  -t "$WORKER_IMAGE" \
  --push \
  .

if aws_cli secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "[deploy] updating Secrets Manager secret $SECRET_NAME"
  aws_cli secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" \
    --secret-string "file://deploy/aws/.runtime/secrets.production.json" \
    >/dev/null
else
  echo "[deploy] creating Secrets Manager secret $SECRET_NAME"
  aws_cli secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "Mantle agent wallet production runtime credentials" \
    --secret-string "file://deploy/aws/.runtime/secrets.production.json" \
    --tags Key=Project,Value="$APP_NAME" Key=Environment,Value="$ENVIRONMENT" \
    >/dev/null
fi

SECRET_ARN="$(aws_cli secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)"

echo "[deploy] deploying CloudFormation stack $STACK_NAME"
aws_cli cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file deploy/aws/cloudformation.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags Project="$APP_NAME" Environment="$ENVIRONMENT" ManagedBy=codex \
  --parameter-overrides \
    AppName="$APP_NAME" \
    Environment="$ENVIRONMENT" \
    WebImageUri="$WEB_IMAGE" \
    WorkerImageUri="$WORKER_IMAGE" \
    AppSecretArn="$SECRET_ARN" \
    OpenAIModel="$OPENAI_MODEL"

CLUSTER_NAME="${APP_NAME}-${ENVIRONMENT}"
SERVICES=(
  "${APP_NAME}-${ENVIRONMENT}-web"
  "${APP_NAME}-${ENVIRONMENT}-agent"
  "${APP_NAME}-${ENVIRONMENT}-keeper"
  "${APP_NAME}-${ENVIRONMENT}-baseline"
)

echo "[deploy] waiting for ECS services to stabilize"
aws_cli ecs wait services-stable --cluster "$CLUSTER_NAME" --services "${SERVICES[@]}"

DASHBOARD_URL="$(
  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue | [0]" \
    --output text
)"

echo "[deploy] smoke testing $DASHBOARD_URL"
curl --fail --silent --show-error --retry 12 --retry-delay 10 --retry-all-errors "$DASHBOARD_URL" >/dev/null

echo "[deploy] deployment is healthy"
echo "Dashboard: $DASHBOARD_URL"
echo "Image tag: $IMAGE_TAG"
