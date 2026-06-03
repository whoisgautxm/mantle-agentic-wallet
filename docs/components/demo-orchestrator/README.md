# Demo Orchestrator

Rank: 11

Priority: Medium

## Goal

Provide one command that starts, monitors, and stops the full local demo loop without duplicate processes.

## Current Project Fit

Implemented v1 adds `agent` package scripts:

- `npm run demo`
- `npm run demo:start`
- `npm run demo:status`
- `npm run demo:stop`

The orchestrator starts keeper, AI runner, baseline runner, and dashboard with prefixed logs, PID records, duplicate protection, graceful shutdown, and eval summary generation.

The manual fallback still uses separate terminals:

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
agent/src/demoStart.ts
agent/src/demoStop.ts
agent/src/demoStatus.ts
agent/src/runtime/demoRuntime.ts
```

Package scripts:

```json
{
  "demo": "tsx src/demoStart.ts",
  "demo:start": "tsx src/demoStart.ts",
  "demo:stop": "tsx src/demoStop.ts",
  "demo:status": "tsx src/demoStatus.ts"
}
```

## Features

- Reads `.env` once.
- Starts keeper, agent, baseline, and dashboard.
- Writes PID files to `.runtime/`. Implemented.
- Refuses to start duplicate components.
- Streams logs with component prefixes.
- Performs dashboard TCP readiness checks.
- Stops all project processes safely.
- Supports `--no-baseline`, `--no-agent`, `--no-keeper`, `--no-dashboard`, `--prod-dashboard`, `--port`, `--skip-scenario-eval`, `--no-trace-eval`, and `--fresh-trace`.
- Generates scenario eval summary on start and trace eval summary on shutdown for dashboard replay cards.

## Acceptance Criteria

- `npm run demo:start` starts exactly one of each process. Implemented.
- `npm run demo:status` shows port, PID, and last heartbeat. Implemented.
- `npm run demo:stop` stops all project demo processes. Implemented.
- Duplicate startup is blocked with a clear message. Implemented.
- No secrets are printed.

Remaining improvements:

- File heartbeat events from the individual runner loops, not just the orchestrator process.
- Dashboard operations panel for runner PID/heartbeat status.
- Optional background daemon mode if a foreground terminal is not desired.

## Resources

- Node.js child process docs: https://nodejs.org/api/child_process.html
- dotenv docs: https://github.com/motdotla/dotenv
- Next.js CLI docs: https://nextjs.org/docs/app/api-reference/cli/next
