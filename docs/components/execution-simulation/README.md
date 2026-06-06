# Execution Simulation

Rank: 4

Priority: Must-have

## Goal

Add a preflight simulation layer before every transaction. The agent should not send `AgentVault.execute` until simulation proves the call is likely to succeed and the result is within risk limits.

## Current Project Fit

Implemented v1 now gates `submitExecute()` with a preflight simulation before `writeContract`. The AI runner and deterministic baseline runner both compute a simulation result, pass it into risk evaluation, and pass the same result into submission so a failed simulation cannot accidentally proceed.

Execution plans now carry normalized `expectedOutWei`, `minOutWei`, `slippageBps`, and optional `deadlineSeconds` metadata. Merchant Moe has readiness and fork-simulation CLIs that verify quote/slippage/reference/fork preconditions while keeping execution disabled.

Implemented fork simulation v1:

- `npm run simulate:merchant-moe-fork` writes `merchant_moe.fork_simulation` JSONL evidence.
- The command blocks until a fork RPC and simulation account are configured.
- When no explicit calldata fixture is provided, it builds simulation-only Merchant Moe LBRouter calldata from quote route metadata, minOut, recipient, and deadline.
- Before calling the router, it reads token-in balance and LBRouter allowance for the swap owner and blocks insufficient state with explicit findings.
- It can simulate a direct LBRouter call or `AgentVault.execute` on a fork where the vault exists.
- It records attempted/passed status, gas estimate, revert reason, blockers, and next steps without submitting to a live network; the Anvil fixture may submit disposable fork-local transactions.
- `npm run simulate:merchant-moe-fixture` runs the same gate with deterministic quote, reference, balance, allowance, calldata, and injected fork-client state so the dashboard can show a controlled pass while live execution stays disabled.
- `npm run simulate:merchant-moe-anvil` starts a disposable Mantle mainnet fork, deploys the project `AgentVault`, wraps fork-only MNT and approves the real LBRouter through `AgentVault.execute`, simulates the guarded swap, executes it once on the disposable fork, verifies token deltas plus `AgentDecision`, records fork/setup evidence, and shuts the fork down.

The remaining next steps are richer gas/cost reporting and regression fixtures for paused vault, disallowed router, failed slippage, stale oracle, and unsafe allowance cases.

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
- Merchant Moe fork simulation reports fork RPC/call-precondition status and can simulate provided calldata without live submission. Implemented.

## Resources

- viem `simulateContract`: https://viem.sh/docs/contract/simulateContract
- viem public client actions: https://viem.sh/docs/actions/public/introduction
- viem gas estimation: https://viem.sh/docs/actions/public/estimateFeesPerGas
- Ethereum JSON-RPC `eth_call`: https://ethereum.org/developers/docs/apis/json-rpc/#eth_call
