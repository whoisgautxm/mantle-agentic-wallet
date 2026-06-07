import { describe, expect, it } from "vitest";
import type { MarketFeatures, MarketRegime } from "../marketFeatures.js";
import type { VaultState } from "../types.js";
import { regimeRoutedEnsemble } from "./ensemble.js";

const ONE = 10n ** 18n;

const state: VaultState = {
  balanceWei: ONE,
  spendLimitPerTx: ONE / 10n,
  dailyLimit: ONE,
  spentToday: 0n,
  windowStart: 1_000n,
  paused: false,
  tokenBalanceWei: ONE / 2n,
  priceWei: 2n * ONE,
};

function features(regime: MarketRegime, overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    observations: 8,
    regime,
    confidence: 85,
    momentumBps: 300,
    shortSlopeBps: 240,
    longSlopeBps: 180,
    volatilityBps: 80,
    drawdownFromPeakBps: -50,
    latestReturnBps: 90,
    consecutiveUp: 3,
    consecutiveDown: 0,
    ...overrides,
  };
}

function run(
  regime: MarketRegime,
  priceHistory: bigint[],
  featureOverrides: Partial<MarketFeatures> = {},
  stateOverrides: Partial<VaultState> = {},
  estimatedExecutionCostBps = 50,
) {
  return regimeRoutedEnsemble({
    priceHistory,
    features: features(regime, featureOverrides),
    state: { ...state, ...stateOverrides, priceWei: priceHistory.at(-1) ?? state.priceWei },
    baselineBuyWei: 2n * 10n ** 16n,
    estimatedExecutionCostBps,
  });
}

describe("regime-routed ensemble", () => {
  it("uses meaningful buy size in a high-confidence uptrend", () => {
    const intent = run("trend_up", [2n * ONE, 21n * ONE / 10n, 22n * ONE / 10n, 23n * ONE / 10n]);

    expect(intent.action).toBe("buy");
    expect(intent.amountMntWei).toBeGreaterThanOrEqual(5n * 10n ** 16n);
    expect(intent.sizePercent).toBeGreaterThanOrEqual(50);
  });

  it("never sells while an uptrend and rising streak persist", () => {
    const intent = run(
      "trend_up",
      [2n * ONE, 21n * ONE / 10n, 22n * ONE / 10n, 23n * ONE / 10n],
      { consecutiveUp: 5, shortSlopeBps: 420, latestReturnBps: 130 },
      { tokenBalanceWei: 8n * ONE / 10n },
    );

    expect(intent.action).not.toBe("sell");
  });

  it("never buys a confirmed downtrend", () => {
    const intent = run(
      "trend_down",
      [23n * ONE / 10n, 22n * ONE / 10n, 21n * ONE / 10n, 2n * ONE],
      {
        momentumBps: -300,
        shortSlopeBps: -240,
        longSlopeBps: -180,
        latestReturnBps: -90,
        consecutiveUp: 0,
        consecutiveDown: 3,
      },
    );

    expect(intent.action).not.toBe("buy");
  });

  it("buys range lows, sells range highs, and holds near the mean", () => {
    const low = run(
      "range",
      [2n * ONE, 202n * ONE / 100n, 198n * ONE / 100n, 196n * ONE / 100n],
      { shortSlopeBps: -198, longSlopeBps: -198, latestReturnBps: -101, consecutiveUp: 0, consecutiveDown: 2 },
    );
    const high = run(
      "range",
      [2n * ONE, 198n * ONE / 100n, 202n * ONE / 100n, 204n * ONE / 100n],
      { shortSlopeBps: 202, longSlopeBps: 202, latestReturnBps: 99, consecutiveUp: 2, consecutiveDown: 0 },
    );
    const near = run(
      "range",
      [2n * ONE, 201n * ONE / 100n, 199n * ONE / 100n, 2n * ONE],
      { shortSlopeBps: 0, longSlopeBps: 0, latestReturnBps: 50, consecutiveUp: 1, consecutiveDown: 0 },
    );

    expect(low.action).toBe("buy");
    expect(high.action).toBe("sell");
    expect(near.action).toBe("hold");
  });

  it("holds on the shock tick and makes only a small recovery buy", () => {
    const crash = run(
      "shock",
      [2n * ONE, 2n * ONE, 14n * ONE / 10n],
      {
        shortSlopeBps: -3_000,
        longSlopeBps: -3_000,
        latestReturnBps: -3_000,
        drawdownFromPeakBps: -3_000,
        consecutiveUp: 0,
        consecutiveDown: 1,
      },
    );
    const recovery = run(
      "shock",
      [2n * ONE, 14n * ONE / 10n, 145n * ONE / 100n],
      {
        shortSlopeBps: -2_750,
        longSlopeBps: -2_750,
        latestReturnBps: 357,
        drawdownFromPeakBps: -2_750,
        consecutiveUp: 1,
        consecutiveDown: 0,
      },
    );

    expect(crash.action).toBe("hold");
    expect(recovery.action).toBe("buy");
    expect(recovery.amountMntWei).toBeLessThanOrEqual(2n * 10n ** 16n);
  });

  it("downgrades an edge that does not clear costs and buffer to hold", () => {
    const intent = run(
      "range",
      [2n * ONE, 202n * ONE / 100n, 198n * ONE / 100n, 196n * ONE / 100n],
      { shortSlopeBps: -198, longSlopeBps: -198, momentumBps: -200, latestReturnBps: -101 },
      {},
      200,
    );

    expect(intent.action).toBe("hold");
    expect(intent.rationale).toContain("cost threshold");
  });
});
