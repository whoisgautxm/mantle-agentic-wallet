import { describe, expect, it } from "vitest";
import { candidateMaterialChangeReason, driftBps } from "./candidateRevalidation.js";
import type { TradeCandidate } from "./brain.js";
import type { VaultState } from "./types.js";

const state: VaultState = {
  balanceWei: 1n * 10n ** 18n,
  spendLimitPerTx: 1n * 10n ** 17n,
  dailyLimit: 5n * 10n ** 18n,
  spentToday: 0n,
  windowStart: 1_000n,
  paused: false,
  tokenBalanceWei: 0n,
  priceWei: 2n * 10n ** 18n,
  blockNumber: 100n,
};

const candidate: TradeCandidate = {
  id: "candidate-1",
  action: "buy",
  amountMntWei: 5n * 10n ** 16n,
  regime: "trend_up",
  confidence: 80,
  sizePercent: 50,
  expectedEdgeBps: 350,
  estimatedExecutionCostBps: 70,
  rationale: "confirmed uptrend",
  evidence: ["trend_up"],
};

const policy = {
  maxPriceDriftBps: 150n,
  maxAmountDriftBps: 250n,
};

describe("candidate revalidation", () => {
  it("computes absolute basis-point drift", () => {
    expect(driftBps(21n * 10n ** 17n, 2n * 10n ** 18n)).toBe(500n);
    expect(driftBps(19n * 10n ** 17n, 2n * 10n ** 18n)).toBe(500n);
  });

  it("allows equivalent refreshed candidates inside drift limits", () => {
    const reason = candidateMaterialChangeReason(
      candidate,
      { ...candidate, id: "candidate-2" },
      state,
      { ...state, priceWei: 2005n * 10n ** 15n, blockNumber: 101n },
      policy,
    );

    expect(reason).toBeUndefined();
  });

  it("blocks when action changes", () => {
    const reason = candidateMaterialChangeReason(
      candidate,
      { ...candidate, action: "sell", amountMntWei: undefined, amountTokenWei: 1n },
      state,
      state,
      policy,
    );

    expect(reason).toContain("action changed");
  });

  it("blocks when regime changes", () => {
    const reason = candidateMaterialChangeReason(
      candidate,
      { ...candidate, regime: "range" },
      state,
      state,
      policy,
    );

    expect(reason).toContain("regime changed");
  });

  it("blocks when price drift exceeds the configured tolerance", () => {
    const reason = candidateMaterialChangeReason(
      candidate,
      candidate,
      state,
      { ...state, priceWei: 21n * 10n ** 17n },
      policy,
    );

    expect(reason).toContain("price drift 500 bps");
  });

  it("blocks when candidate amount drift exceeds the configured tolerance", () => {
    const reason = candidateMaterialChangeReason(
      candidate,
      { ...candidate, amountMntWei: 6n * 10n ** 16n },
      state,
      state,
      policy,
    );

    expect(reason).toContain("candidate amount drift 2000 bps");
  });
});
