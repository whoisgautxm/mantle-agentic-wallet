import type { Decision, VaultState, PolicyResult } from "./types.js";

/// Mirrors AgentVault's on-chain checks so the agent never submits a doomed tx.
/// The contract remains the source of truth; this is a client-side pre-flight.
export function checkPolicy(decision: Decision, state: VaultState): PolicyResult {
  if (decision.kind === "hold") return { ok: true };

  if (state.paused) return { ok: false, reason: "vault is paused" };
  if (decision.valueWei > state.spendLimitPerTx)
    return { ok: false, reason: "over per-tx limit" };
  if (state.spentToday + decision.valueWei > state.dailyLimit)
    return { ok: false, reason: "over daily limit" };
  if (decision.valueWei > state.balanceWei)
    return { ok: false, reason: "insufficient vault balance" };

  return { ok: true };
}
