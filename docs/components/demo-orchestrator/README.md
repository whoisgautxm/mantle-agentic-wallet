# Demo Orchestrator

Rank: 11

Priority: Medium

## Goal

Provide one command that starts, monitors, and stops the full local demo loop without duplicate processes.

## Current Project Fit

The current demo uses separate terminals:

- `npm run keeper`
- `npm start`
- `npm run baseline`
- `npm run dev` or `npm run start`

This works, but it is easy to accidentally run duplicate agents or baseline loops, which can create confusing on-chain behavior and unnecessary testnet transactions.

## Real Problems It Solves

- duplicate runners
- stale localhost servers
- wrong port confusion
- hidden process leaks
- inconsistent env loading
- noisy demo setup before judging
- hard-to-reproduce screenshots

## Integration Design

Add:

```text
scripts/
  demo-runner.ts
  demo-stop.ts
  demo-status.ts

agent/src/runtime/
  lockfile.ts
  heartbeat.ts
```

Package scripts:

```json
{
  "demo:start": "tsx scripts/demo-runner.ts",
  "demo:stop": "tsx scripts/demo-stop.ts",
  "demo:status": "tsx scripts/demo-status.ts"
}
```

## Features

- Reads `.env` once.
- Starts keeper, agent, baseline, and dashboard.
- Writes PID files to `.runtime/`.
- Refuses to start duplicate components.
- Streams logs with component prefixes.
- Performs health checks.
- Stops all project processes safely.
- Supports `--no-baseline`, `--no-agent`, `--prod-dashboard`, and `--port`.

## Acceptance Criteria

- `npm run demo:start` starts exactly one of each process.
- `npm run demo:status` shows port, PID, and last heartbeat.
- `npm run demo:stop` stops all project demo processes.
- Duplicate startup is blocked with a clear message.
- No secrets are printed.

## Resources

- Node.js child process docs: https://nodejs.org/api/child_process.html
- dotenv docs: https://github.com/motdotla/dotenv
- Next.js CLI docs: https://nextjs.org/docs/app/api-reference/cli/next
