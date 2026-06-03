# Execution Simulation

Rank: 4

Priority: Must-have

## Goal

Add a preflight simulation layer before every transaction. The agent should not send `AgentVault.execute` until simulation proves the call is likely to succeed and the result is within risk limits.

## Current Project Fit

Implemented v1 now gates `submitExecute()` with a preflight simulation before `writeContract`. The AI runner and deterministic baseline runner both compute a simulation result, pass it into risk evaluation, and pass the same result into submission so a failed simulation cannot accidentally proceed.

Execution plans now carry normalized `expectedOutWei`, `minOutWei`, `slippageBps`, and optional `deadlineSeconds` metadata. Merchant Moe has a fork-readiness CLI that verifies quote/slippage/reference/fork preconditions while keeping execution disabled.

The remaining next steps are richer gas/cost reporting, dashboard surfacing, and actual mainnet-fork protocol simulations for real adapters once calldata generation exists.

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

- Failed simulation blocks execution. Implemented in `agent/src/chain.ts`.
- Revert reason is surfaced in risk/submit errors. Dashboard surfacing remains future work.
- Existing MockDEX AI and baseline trades still use the same execution path.
- Unit tests cover successful simulations, gas-estimate warnings, failed simulations, and submit blocking.
- Simulation result is included in local risk evaluation. Structured decision-log persistence remains future work.
- Merchant Moe fork readiness reports min-output/slippage metadata and blocks execution while calldata remains disabled. Implemented.

## Resources

- viem `simulateContract`: https://viem.sh/docs/contract/simulateContract
- viem public client actions: https://viem.sh/docs/actions/public/introduction
- viem gas estimation: https://viem.sh/docs/actions/public/estimateFeesPerGas
- Ethereum JSON-RPC `eth_call`: https://ethereum.org/developers/docs/apis/json-rpc/#eth_call
