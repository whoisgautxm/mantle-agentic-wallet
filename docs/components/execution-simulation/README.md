# Execution Simulation

Rank: 4

Priority: Must-have

## Goal

Add a preflight simulation layer before every transaction. The agent should not send `AgentVault.execute` until simulation proves the call is likely to succeed and the result is within risk limits.

## Current Project Fit

Today, `submitExecute()` writes to the vault and checks the receipt status after the transaction lands. That confirms success after gas is spent. The next phase should simulate before write.

## Real Problems It Solves

- Reverts due to protocol state changing.
- Missing token approvals.
- Insufficient output amounts.
- Wrong function selector or target.
- Gas surprises.
- Paused vault or disallowed target.
- Broken adapter calldata.

## Integration Design

Add:

```text
agent/src/simulation/
  simulator.ts
  types.ts
  gas.ts
```

Simulation input:

```ts
interface SimulationInput {
  vault: `0x${string}`;
  plan: ExecutionPlan;
  account: `0x${string}`;
}
```

Simulation output:

```ts
interface SimulationResult {
  ok: boolean;
  gasEstimate?: bigint;
  returnData?: `0x${string}`;
  revertReason?: string;
  warnings: string[];
}
```

Use viem:

- `publicClient.simulateContract()` for `AgentVault.execute`.
- `publicClient.estimateGas()` or viem gas helpers for cost projection.
- optional state overrides only for tests, not production decisions.

## Execution Flow

```text
AI intent
  -> adapter builds ExecutionPlan
  -> risk engine preliminary checks
  -> simulator validates AgentVault.execute
  -> risk engine final checks with simulation result
  -> walletClient.writeContract
```

## Acceptance Criteria

- Failed simulation blocks execution.
- Revert reason is surfaced in logs/dashboard.
- Existing MockDEX trades still execute.
- Adapter tests include at least one malformed calldata simulation failure.
- Simulation result is included in local decision logs.

## Resources

- viem `simulateContract`: https://viem.sh/docs/contract/simulateContract
- viem public client actions: https://viem.sh/docs/actions/public/introduction
- viem gas estimation: https://viem.sh/docs/actions/public/estimateFeesPerGas
- Ethereum JSON-RPC `eth_call`: https://ethereum.org/developers/docs/apis/json-rpc/#eth_call
