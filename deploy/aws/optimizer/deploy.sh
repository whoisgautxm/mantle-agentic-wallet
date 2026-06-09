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
SECRET_NAME="${SECRET_NAME:-${APP_NAME}/${ENVIRONMENT}}"
OPTIMIZER_SECRET_NAME="${OPTIMIZER_SECRET_NAME:-${APP_NAME}/optimizer}"
REPOSITORY_URL="${REPOSITORY_URL:-$(git remote get-url origin)}"
SOURCE_VERSION="${SOURCE_VERSION:-$(git branch --show-current)}"
CODEX_MODEL="${OPTIMIZER_MODEL:-gpt-5.5}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.137.0}"
MAX_ITERATIONS="${OPTIMIZER_MAX_ITERATIONS:-3}"
STOP_AFTER_REJECTIONS="${OPTIMIZER_STOP_AFTER_REJECTIONS:-2}"
COMPUTE_TYPE="${OPTIMIZER_COMPUTE_TYPE:-BUILD_GENERAL1_MEDIUM}"
RUNTIME_DIR="$ROOT/deploy/aws/.runtime"
CODEX_SECRET_FILE="$RUNTIME_DIR/optimizer-secret.json"

mkdir -p "$RUNTIME_DIR"
trap 'rm -f "$CODEX_SECRET_FILE"' EXIT

aws_cli() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    "$ROOT/deploy/aws/aws-docker.sh" "$@"
  fi
}

if [[ "${SKIP_SOURCE_CHECK:-0}" != "1" ]]; then
  [[ -z "$(git status --porcelain)" ]] || {
    echo "[optimizer-deploy] commit the optimizer changes before deploying" >&2
    exit 1
  }
  LOCAL_COMMIT="$(git rev-parse HEAD)"
  REMOTE_COMMIT="$(
    git ls-remote "$REPOSITORY_URL" "refs/heads/$SOURCE_VERSION" |
      awk 'NR == 1 { print $1 }'
  )"
  [[ -n "$REMOTE_COMMIT" ]] || {
    echo "[optimizer-deploy] remote branch $SOURCE_VERSION was not found" >&2
    exit 1
  }
  [[ "$LOCAL_COMMIT" == "$REMOTE_COMMIT" ]] || {
    echo "[optimizer-deploy] local HEAD is not the pushed $SOURCE_VERSION commit" >&2
    echo "local:  $LOCAL_COMMIT" >&2
    echo "remote: $REMOTE_COMMIT" >&2
    exit 1
  }
fi

echo "[optimizer-deploy] validating AWS identity"
aws_cli sts get-caller-identity >/dev/null

SOURCE_SECRET_ARN="$(
  aws_cli secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --query ARN \
    --output text
)"

echo "[optimizer-deploy] creating a Codex-only optimizer secret"
aws_cli secretsmanager get-secret-value \
  --secret-id "$SOURCE_SECRET_ARN" \
  --query SecretString \
  --output text |
  node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const key = JSON.parse(source).OPENAI_API_KEY;
      if (!key || typeof key !== "string") {
        throw new Error("OPENAI_API_KEY is missing from the application secret");
      }
      process.stdout.write(`${JSON.stringify({ CODEX_API_KEY: key })}\n`);
    });
  ' >"$CODEX_SECRET_FILE"
chmod 600 "$CODEX_SECRET_FILE"

if aws_cli secretsmanager describe-secret --secret-id "$OPTIMIZER_SECRET_NAME" >/dev/null 2>&1; then
  aws_cli secretsmanager put-secret-value \
    --secret-id "$OPTIMIZER_SECRET_NAME" \
    --secret-string "file://$CODEX_SECRET_FILE" \
    >/dev/null
else
  aws_cli secretsmanager create-secret \
    --name "$OPTIMIZER_SECRET_NAME" \
    --description "Codex-only credential for bounded Mantle strategy optimization" \
    --secret-string "file://$CODEX_SECRET_FILE" \
    --tags Key=Project,Value="$APP_NAME" Key=Environment,Value="$ENVIRONMENT" \
    >/dev/null
fi

CODEX_SECRET_ARN="$(
  aws_cli secretsmanager describe-secret \
    --secret-id "$OPTIMIZER_SECRET_NAME" \
    --query ARN \
    --output text
)"

echo "[optimizer-deploy] deploying $STACK_NAME"
aws_cli cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file deploy/aws/optimizer/cloudformation.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags Project="$APP_NAME" Environment="$ENVIRONMENT" ManagedBy=codex \
  --parameter-overrides \
    AppName="$APP_NAME" \
    Environment="$ENVIRONMENT" \
    RepositoryUrl="$REPOSITORY_URL" \
    SourceVersion="$SOURCE_VERSION" \
    CodexSecretArn="$CODEX_SECRET_ARN" \
    CodexModel="$CODEX_MODEL" \
    CodexCliVersion="$CODEX_CLI_VERSION" \
    MaxIterations="$MAX_ITERATIONS" \
    StopAfterRejections="$STOP_AFTER_REJECTIONS" \
    ComputeType="$COMPUTE_TYPE"

aws_cli cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[].{key:OutputKey,value:OutputValue}" \
  --output table
