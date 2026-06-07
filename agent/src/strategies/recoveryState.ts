// Recovery-state machine (live-run report P1): the stateless regime classifier recognized the
// downtrend but lost transition context after the first bounce, so the agent never entered the
// recovery. This derives a recovery phase from the observed price history alone (no external state,
// no lookahead) so the ensemble can take a small, cost-aware recovery probe when a downtrend
// stabilizes and bounces — the upside the AI previously left entirely to DCA.

export type RecoveryPhase = "neutral" | "downtrend" | "stabilizing" | "recovery_probe";

export interface RecoveryConfig {
  minObservations: number;
  minDrawdownBps: number; // a meaningful drop must have happened (peak-before-low to low)
  recoveryBounceBps: number; // how far price has reclaimed off the low to call it a probe
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  minObservations: 4,
  minDrawdownBps: 300,
  recoveryBounceBps: 150,
};

export interface RecoveryState {
  phase: RecoveryPhase;
  lowWei: bigint;
  bounceBps: number; // rise from the low to the latest price
  drawdownBps: number; // peak-before-low to low (negative)
}

function bps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * 10_000n) / denominator);
}

export function deriveRecoveryPhase(
  priceHistory: readonly bigint[],
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): RecoveryState {
  const n = priceHistory.length;
  if (n < config.minObservations) {
    return { phase: "neutral", lowWei: priceHistory[n - 1] ?? 0n, bounceBps: 0, drawdownBps: 0 };
  }

  let lowWei = priceHistory[0];
  let lowIdx = 0;
  for (let i = 1; i < n; i++) {
    if (priceHistory[i] < lowWei) {
      lowWei = priceHistory[i];
      lowIdx = i;
    }
  }
  let peakBeforeLow = priceHistory[0];
  for (let i = 0; i <= lowIdx; i++) {
    if (priceHistory[i] > peakBeforeLow) peakBeforeLow = priceHistory[i];
  }
  const latest = priceHistory[n - 1];
  const drawdownBps = bps(lowWei - peakBeforeLow, peakBeforeLow); // <= 0
  const bounceBps = bps(latest - lowWei, lowWei); // >= 0

  if (drawdownBps > -config.minDrawdownBps) {
    return { phase: "neutral", lowWei, bounceBps, drawdownBps };
  }
  if (lowIdx === n - 1) {
    // The low is the most recent observation — still falling, not yet stabilized.
    return { phase: "downtrend", lowWei, bounceBps, drawdownBps };
  }
  if (bounceBps >= config.recoveryBounceBps) {
    return { phase: "recovery_probe", lowWei, bounceBps, drawdownBps };
  }
  return { phase: "stabilizing", lowWei, bounceBps, drawdownBps };
}
