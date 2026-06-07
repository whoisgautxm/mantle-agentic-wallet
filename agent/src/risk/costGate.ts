// Dynamic execution-cost gate (live-run report P1): replace the fixed execution-cost assumption with
// observed cost. A trade is only worth submitting when its expected gross edge clears the realized
// fee + slippage + gas (relative to the trade notional) plus a buffer. This is what stops uneconomic
// trades like a 0.005 MNT order that costs ~0.005 MNT in gas.

export interface CostGateInput {
  expectedEdgeBps: number;
  feeBps: number;
  slippageBps: number;
  bufferBps: number;
  gasEstimateWei: bigint;
  gasPriceWei: bigint;
  tradeNotionalWei: bigint;
}

export interface CostGateResult {
  ok: boolean;
  gasBps: number;
  totalCostBps: number;
  reason?: string;
}

export function evaluateCostGate(input: CostGateInput): CostGateResult {
  const { expectedEdgeBps, feeBps, slippageBps, bufferBps, gasEstimateWei, gasPriceWei, tradeNotionalWei } = input;
  if (tradeNotionalWei <= 0n) {
    return {
      ok: false,
      gasBps: Number.POSITIVE_INFINITY,
      totalCostBps: Number.POSITIVE_INFINITY,
      reason: "zero trade notional",
    };
  }
  const gasCostWei = gasEstimateWei * gasPriceWei;
  // Do the *10000 in bigint, then Number() the small bps quotient to avoid precision loss.
  const gasBps = Number((gasCostWei * 10_000n) / tradeNotionalWei);
  const totalCostBps = feeBps + slippageBps + gasBps + bufferBps;
  const ok = expectedEdgeBps > totalCostBps;
  return {
    ok,
    gasBps,
    totalCostBps,
    reason: ok ? undefined : `expected edge ${expectedEdgeBps} bps <= execution cost ${totalCostBps} bps (gas ${gasBps} bps)`,
  };
}
