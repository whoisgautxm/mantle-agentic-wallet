# AWS Deployment Guide

The AWS stack runs four ECS/Fargate services:

- `web`: Next.js dashboard behind an internet-facing Application Load Balancer.
- `agent`: OpenAI strategy loop submitting guarded Mantle Sepolia vault actions.
- `keeper`: owner-key MockDEX/MockOracle price updater.
- `baseline`: deterministic DCA comparison runner.

The stack also creates EFS storage shared by all services for JSONL traces, CloudWatch log groups, a dedicated VPC, and rollback-enabled ECS deployments. Worker desired counts are capped at one to prevent duplicate transactions.

CloudFront is intentionally not enabled in the first deployment template because new AWS accounts often fail with `Your account must be verified before you can add new CloudFront resources`. Add CloudFront or an ACM-backed custom domain after AWS account verification.

## Prerequisites

- Docker Desktop is running.
- Root `.env` contains funded Mantle Sepolia keys and a usable OpenAI API key.
- AWS credentials can create ECR, ECS, EC2/VPC, ALB, CloudFront, EFS, IAM, Secrets Manager, and CloudWatch resources.
- The target region has at least two availability zones. The default is `ap-south-1`.

Verify AWS authentication before deploying:

```bash
export AWS_PROFILE=mantle
export AWS_REGION=ap-south-1
./deploy/aws/aws-docker.sh sts get-caller-identity
```

If this returns `InvalidClientTokenId`, replace the placeholder access key and secret in `~/.aws/credentials` or authenticate with a valid organization-provided profile. Never commit or paste AWS credentials into the repository.

If `sts get-caller-identity` works but deployment fails with `AccessDenied`, the IAM user is authenticated but under-permissioned. For the fastest hackathon deployment, attach AWS managed policy `AdministratorAccess` to `mantle-deployer`, deploy, then remove it after the demo. For a narrower deployer policy, create an IAM customer-managed policy from `deploy/aws/iam-deployer-policy.json` and attach it to `mantle-deployer`.

## Deploy

From the repository root:

```bash
chmod +x deploy/aws/*.sh
AWS_PROFILE=mantle AWS_REGION=ap-south-1 ./deploy/aws/deploy.sh
```

The deploy script:

1. Verifies AWS identity.
2. Safely renders the required `.env` fields into an ignored temporary JSON file.
3. Creates or updates two encrypted ECR repositories.
4. Runs agent and web tests/builds.
5. Builds immutable `linux/amd64` images and pushes them to ECR.
6. Creates or updates the Secrets Manager secret.
7. Deploys `deploy/aws/cloudformation.yml`.
8. Waits for all four ECS services and smoke-tests the public ALB URL.

The temporary secret file is deleted automatically. Live Merchant Moe mainnet execution is hard-disabled in the task definitions.

Set `RUN_TESTS=0` only when redeploying an already-verified commit:

```bash
RUN_TESTS=0 AWS_PROFILE=mantle AWS_REGION=ap-south-1 ./deploy/aws/deploy.sh
```

## Status And Logs

```bash
AWS_PROFILE=mantle AWS_REGION=ap-south-1 ./deploy/aws/status.sh
```

CloudWatch log groups:

- `/ecs/mantle-agent-wallet/prod/web`
- `/ecs/mantle-agent-wallet/prod/agent`
- `/ecs/mantle-agent-wallet/prod/keeper`
- `/ecs/mantle-agent-wallet/prod/baseline`

The dashboard uses live Mantle Sepolia logs through `LOGS_RPC_URL`, live contract reads through `MANTLE_RPC_URL`, and shared EFS traces for simulation/eval panels.

## Codex Strategy Optimization

The production ECS stack does not self-modify. Strategy experiments run in a
separate, manually started CodeBuild project with deterministic development
evals, a held-out promotion gate, a Codex-only secret, and S3 artifacts for human
review.

See [optimizer/README.md](optimizer/README.md) for deployment, monitoring, cost
limits, and promotion commands.

## Rollback

ECS deployment circuit breakers automatically roll a failed service revision back. To redeploy a known image, rerun `deploy.sh` with its previous `IMAGE_TAG`.

To delete the running stack:

```bash
AWS_PROFILE=mantle AWS_REGION=ap-south-1 ./deploy/aws/destroy.sh
```

This removes ECS, ALB, VPC, and EFS trace data. ECR images and the Secrets Manager secret are intentionally retained.

## Local Container Smoke

```bash
docker compose -f deploy/docker/docker-compose.aws.yml build
docker compose -f deploy/docker/docker-compose.aws.yml up web
```

To run all workers locally:

```bash
docker compose -f deploy/docker/docker-compose.aws.yml --profile workers up
```

## Safety Checklist

- Confirm `shared/addresses.json` still points to Mantle Sepolia chain ID `5003`.
- Use separate testnet keys for owner, AI, and baseline roles.
- Keep each worker desired count at exactly one.
- Keep `MERCHANT_MOE_LIVE_EXECUTION_ENABLED=false`.
- Do not use mainnet-funded private keys in this deployment.
- Add CloudFront, a custom domain, and an ACM certificate later if a branded HTTPS URL is required.
