import { describe, it, expect } from "vitest";
import { evaluateCostGate } from "./costGate.js";

describe("evaluateCostGate", () => {
  it("blocks a trade whose gas dominates a tiny notional (live-run: gas was ~131% of a 0.005 MNT order)", () => {
    const result = evaluateCostGate({
      expectedEdgeBps: 50,
      feeBps: 30,
      slippageBps: 20,
      bufferBps: 10,
      gasEstimateWei: 101_898n,
      gasPriceWei: 50_000_000_000n, // ~0.0050949 MNT gas
      tradeNotionalWei: 5_000_000_000_000_000n, // 0.005 MNT
    });
    expect(result.ok).toBe(false);
    expect(result.gasBps).toBeGreaterThan(10_000); // gas alone exceeds 100% of the notional
  });

  it("passes when expected edge exceeds total cost", () => {
    const result = evaluateCostGate({
      expectedEdgeBps: 500,
      feeBps: 30,
      slippageBps: 20,
      bufferBps: 10,
      gasEstimateWei: 100_000n,
      gasPriceWei: 1_000_000_000n, // gas cost 1e14 wei = 0.0001 MNT
      tradeNotionalWei: 1_000_000_000_000_000_000n, // 1 MNT
    });
    expect(result.gasBps).toBe(1);
    expect(result.totalCostBps).toBe(61);
    expect(result.ok).toBe(true);
  });

  it("blocks zero-notional trades", () => {
    const result = evaluateCostGate({
      expectedEdgeBps: 9_999,
      feeBps: 0,
      slippageBps: 0,
      bufferBps: 0,
      gasEstimateWei: 1n,
      gasPriceWei: 1n,
      tradeNotionalWei: 0n,
    });
    expect(result.ok).toBe(false);
  });
});
