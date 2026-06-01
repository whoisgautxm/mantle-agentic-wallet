# Monitoring and Alerting

Rank: 9

Priority: Medium

## Goal

Add operational monitoring so the wallet behaves like a supervised autonomous system rather than a script running in a terminal.

## Current Project Fit

The project already has optional Telegram alerts and console logs. Monitoring should build on that and track the live loop:

- keeper health
- AI runner health
- baseline runner health
- RPC errors and rate limits
- blocked risk decisions
- failed simulations
- on-chain transaction failures
- drawdown/circuit breaker state

## Real Problems It Solves

- Runners silently stop.
- RPC provider rate-limits calls.
- Agent repeatedly holds due to stale data.
- Baseline drains daily limit faster than expected.
- A vault is paused or disallowed.
- A transaction gets stuck or reverts.
- Unexpected approvals or balances appear.

## Integration Design

Add:

```text
agent/src/monitoring/
  events.ts
  health.ts
  alerts.ts
  sinks/
    console.ts
    telegram.ts
    file.ts
```

Standard event:

```ts
interface MonitoringEvent {
  level: "info" | "warn" | "error" | "critical";
  component: "agent" | "baseline" | "keeper" | "dashboard" | "risk" | "rpc";
  code: string;
  message: string;
  txHash?: `0x${string}`;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
```

## Alerts to Add

- `RPC_RATE_LIMITED`
- `RUNNER_HEARTBEAT_MISSED`
- `RISK_DECISION_BLOCKED`
- `SIMULATION_FAILED`
- `TX_REVERTED`
- `DRAWDOWN_BREAKER_TRIGGERED`
- `ORACLE_STALE`
- `UNSAFE_ALLOWANCE_DETECTED`
- `VAULT_BALANCE_LOW`

## Dashboard Implications

Add an Operations panel:

- runner status
- last heartbeat
- last alert
- RPC retry count
- failed simulation count
- latest tx status

## Acceptance Criteria

- All runners emit heartbeat events.
- Risk blocks generate warning events.
- Critical events can go to Telegram if env vars are configured.
- Events can be written locally as JSONL for later analysis/evals.
- Dashboard can read the latest local or on-chain status where available.

## Resources

- Current project Telegram implementation: `agent/src/telegram.ts`
- OpenAI tracing for custom workflow events: https://openai.github.io/openai-agents-js/guides/tracing/
- viem transaction receipt reads: https://viem.sh/docs/actions/public/getTransactionReceipt
