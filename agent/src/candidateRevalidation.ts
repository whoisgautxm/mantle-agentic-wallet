import type { TradeCandidate } from "./brain.js";
import type { VaultState } from "./types.js";

export interface CandidateRevalidationPolicy {
  maxPriceDriftBps: bigint;
  maxAmountDriftBps: bigint;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function driftBps(current: bigint, reference: bigint): bigint {
  if (reference <= 0n) return 0n;
  return (absDiff(current, reference) * 10_000n) / reference;
}

export function candidateAmountWei(candidate: TradeCandidate): bigint {
  return candidate.action === "buy" ? candidate.amountMntWei ?? 0n : candidate.amountTokenWei ?? 0n;
}

export function candidateMaterialChangeReason(
  original: TradeCandidate,
  refreshed: TradeCandidate,
  originalState: VaultState,
  refreshedState: VaultState,
  policy: CandidateRevalidationPolicy,
): string | undefined {
  if (original.action !== refreshed.action) {
    return `action changed from ${original.action} to ${refreshed.action}`;
  }
  if (original.regime !== refreshed.regime) {
    return `regime changed from ${original.regime} to ${refreshed.regime}`;
  }
  const priceDrift = driftBps(refreshedState.priceWei, originalState.priceWei);
  if (priceDrift > policy.maxPriceDriftBps) {
    return `price drift ${priceDrift} bps exceeds ${policy.maxPriceDriftBps} bps`;
  }
  const amountDrift = driftBps(candidateAmountWei(refreshed), candidateAmountWei(original));
  if (amountDrift > policy.maxAmountDriftBps) {
    return `candidate amount drift ${amountDrift} bps exceeds ${policy.maxAmountDriftBps} bps`;
  }
  return undefined;
}
