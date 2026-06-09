#!/usr/bin/env bash
set -euo pipefail

AWS_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.31.23}"
AWS_HOME_MOUNT_MODE="${AWS_DOCKER_AWS_HOME_MODE:-ro}"

docker_args=(
  --rm
  -e AWS_ACCESS_KEY_ID
  -e AWS_SECRET_ACCESS_KEY
  -e AWS_SESSION_TOKEN
  -e AWS_PROFILE
  -e AWS_REGION
  -e AWS_DEFAULT_REGION
  -v "$HOME/.aws:/root/.aws:$AWS_HOME_MOUNT_MODE"
  -v "$PWD:/workspace"
  -w /workspace
)

if [[ -t 0 && -t 1 ]]; then
  docker_args+=(-it)
fi

exec docker run "${docker_args[@]}" "$AWS_IMAGE" "$@"
