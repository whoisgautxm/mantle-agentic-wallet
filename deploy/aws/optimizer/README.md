# AWS Codex Strategy Optimizer

This component runs a bounded AI-strategy improvement loop in an isolated AWS
CodeBuild job. It is deliberately separate from the production ECS services and
never deploys a candidate, submits a transaction, or receives wallet/RPC
credentials.

## What It Optimizes

Codex may change exactly one file:

```text
agent/src/strategies/ensemble.ts
```

Each iteration proposes one focused hypothesis. The outer deterministic
controller then runs the full agent test/build gate and scores the candidate on
40 versioned development regimes. A candidate must improve composite score while
preserving ROI, drawdown, per-fixture behavior, and comparator edges.

After all Codex turns finish, the best development candidate is evaluated once
against 200 held-out regimes. Codex does not receive those fixtures or their
scores in its proposal workspace.

Current versioned baseline:

| Phase | Regimes | Net ROI | Composite | Worst drawdown | DCA edge | Momentum edge |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 40 | 53 bps | 31 bps | -30 bps | +95 bps | +38 bps |
| Held-out | 200 | 61 bps | 36 bps | -105 bps | +122 bps | +37 bps |

These are deterministic fixture results, not a promise of future live returns.

## Safety Model

- The optimizer is a manually started CodeBuild job with a maximum iteration
  count, a 120-minute timeout, and one concurrent build.
- The default budget is three Codex attempts and an early stop after two
  consecutive rejections.
- The production Secrets Manager object is never attached to CodeBuild.
  `deploy.sh` creates a separate `${APP_NAME}/optimizer` secret containing only
  `CODEX_API_KEY`.
- `CODEX_API_KEY` is provided only to the single `codex exec` process. Model-run
  shell commands use Codex's core environment and explicitly exclude
  `AWS_*`, `CODEX_*`, and `OPENAI_*`.
- Codex runs with `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, and `--sandbox workspace-write`.
- Tests, fixtures, risk controls, execution code, deployment code, and lockfiles
  are immutable to the candidate. Any extra changed path is rejected.
- Development acceptance is not deployment approval. The final output is an S3
  artifact for human review.

## One-Time Setup

Commit and push this optimizer implementation first. The deployment script
refuses to create the AWS job when local `HEAD` differs from the selected remote
branch, because the CodeBuild project clones that branch.

```bash
git status
git add .
git commit -m "feat: add bounded AWS strategy optimizer"
git push origin master
```

Deploy the separate optimizer stack:

```bash
chmod +x deploy/aws/optimizer/*.sh
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/deploy.sh
```

The deployer needs CloudFormation, IAM, CodeBuild, S3, CloudWatch Logs, and
Secrets Manager permissions. `deploy/aws/iam-deployer-policy.json` includes the
additional optimizer actions.

## Run The Loop

### CodeBuild

First run a no-Codex AWS smoke test. It verifies dependencies, tests, build,
and both benchmark phases:

```bash
OPTIMIZER_DRY_RUN=1 \
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/start.sh
```

Then run the default three-attempt optimization:

```bash
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
OPTIMIZER_MAX_ITERATIONS=3 \
OPTIMIZER_STOP_AFTER_REJECTIONS=2 \
./deploy/aws/optimizer/start.sh
```

Do not start with a large search. Three attempts are enough to validate the
loop's quality, cost, and stability. Raise the limit only after reviewing the
first artifact ledger.

Some new or restricted AWS accounts expose normal CodeBuild concurrency quotas
but still reject every build with:

```text
Cannot have more than 0 builds in queue for the account
```

That hidden account-level restriction requires an AWS Support case. The
equivalent one-shot Fargate runner below is the supported fallback while the
CodeBuild queue is disabled.

### Fargate Fallback

Build the dedicated optimizer image and deploy its task definition:

```bash
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/deploy-fargate.sh
```

Start a no-Codex dry run:

```bash
OPTIMIZER_DRY_RUN=1 \
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/start-fargate.sh
```

Use the printed task ARN to wait for completion:

```bash
TASK_ARN="<printed-task-arn>" \
WAIT=1 \
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/status-fargate.sh
```

After the dry run passes, remove `OPTIMIZER_DRY_RUN=1` to run the bounded
three-attempt Codex loop. The task exits after completion and uploads the same
artifact layout under `s3://<artifact-bucket>/fargate/<run-id>/`.

## Monitor

Show the latest build, artifact location, and recent CloudWatch logs:

```bash
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/status.sh
```

Follow logs continuously:

```bash
FOLLOW=1 \
AWS_PROFILE=mantle \
AWS_REGION=ap-south-1 \
./deploy/aws/optimizer/status.sh
```

The stack outputs the CodeBuild project, S3 artifact bucket, and CloudWatch log
group. Each build uploads:

- `run-summary.json`: final status and baseline/candidate reports.
- `iterations.jsonl`: replayable attempt ledger.
- `iteration-*-codex-result.json`: structured hypothesis and risk summary.
- `iteration-*-codex-events.jsonl`: complete noninteractive Codex event stream.
- `iteration-*-development-gate.json`: deterministic acceptance decision.
- `best-development.patch`: best development-only candidate, even if held-out
  later rejects it.
- `winner.patch`: present only when the held-out gate approves the candidate.

## Promotion Workflow

1. Download and inspect `winner.patch`, `run-summary.json`, and the iteration
   ledger.
2. Apply the patch on a new branch, never directly on `master`.
3. Run all local tests and the deterministic strategy suite again.
4. Run the synchronized OpenAI-agent evaluation and one fresh live/testnet
   confirmation run.
5. Review strategy rationale, risk exposure, transaction frequency, and costs.
6. Open a pull request and merge only after human approval.
7. Redeploy ECS through the existing `deploy/aws/deploy.sh` path.

A 20-minute live run is useful as final behavioral evidence, but it is too noisy
to be the inner optimization signal. Using it inside the loop encourages
overfitting to one short price window. Deterministic development fixtures drive
the search; held-out fixtures and a synchronized live run confirm generalization.

## Local Harness Smoke

This command does not invoke Codex:

```bash
OPTIMIZER_DRY_RUN=1 ./deploy/aws/optimizer/run-loop.sh
```

It writes ignored artifacts under `optimizer-artifacts/<run-id>/`.
