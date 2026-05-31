import type { Decision, VaultState, PolicyResult } from "./types.js";

const DAY_SECONDS = 24n * 60n * 60n;

function currentUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/// Mirrors AgentVault's on-chain checks so the agent never submits a doomed tx.
/// The contract remains the source of truth; this is a client-side pre-flight.
export function checkPolicy(
  decision: Decision,
  state: VaultState,
  nowSeconds: bigint = currentUnixSeconds(),
): PolicyResult {
  if (decision.kind === "hold") return { ok: true };

  if (state.paused) return { ok: false, reason: "vault is paused" };
  if (decision.valueWei > state.spendLimitPerTx)
    return { ok: false, reason: "over per-tx limit" };
  const spentToday = nowSeconds >= state.windowStart + DAY_SECONDS ? 0n : state.spentToday;
  if (spentToday + decision.valueWei > state.dailyLimit)
    return { ok: false, reason: "over daily limit" };
  if (decision.valueWei > state.balanceWei)
    return { ok: false, reason: "insufficient vault balance" };
  if (decision.action === "sell") {
    if (decision.amountTokenWei === undefined)
      return { ok: false, reason: "sell missing token amount" };
    if (decision.amountTokenWei > state.tokenBalanceWei)
      return { ok: false, reason: "insufficient token balance" };
  }

  return { ok: true };
}
