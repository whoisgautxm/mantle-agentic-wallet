import { describe, expect, it } from "vitest";
import { evaluateLendingHealth, healthFactorBps, weightedLiquidationThresholdBps } from "./health.js";
import type { LendingPositionSnapshot } from "./types.js";

const healthyPosition: LendingPositionSnapshot = {
  protocolId: "lendle",
  account: "0x1111111111111111111111111111111111111111",
  assets: [
    {
      symbol: "USDC",
      suppliedValueWei: 1_000n,
      debtValueWei: 0n,
      liquidationThresholdBps: 8_000n,
    },
    {
      symbol: "WMNT",
      suppliedValueWei: 1_000n,
      debtValueWei: 500n,
      liquidationThresholdBps: 7_000n,
    },
  ],
};

describe("lending health", () => {
  it("computes weighted liquidation threshold and health factor", () => {
    expect(weightedLiquidationThresholdBps(healthyPosition)).toBe(7_500n);
    expect(healthFactorBps(healthyPosition)).toBe(30_000n);
  });

  it("treats a no-debt position as healthy", () => {
    const report = evaluateLendingHealth({
      ...healthyPosition,
      assets: healthyPosition.assets.map((asset) => ({ ...asset, debtValueWei: 0n })),
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("healthy");
    expect(report.healthFactorBps).toBeUndefined();
  });

  it("blocks low health factor debt", () => {
    const report = evaluateLendingHealth({
      ...healthyPosition,
      assets: [{ symbol: "USDC", suppliedValueWei: 1_000n, debtValueWei: 700n, liquidationThresholdBps: 8_000n }],
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocked");
    expect(report.findings.map((finding) => finding.ruleId)).toContain("LENDING_HEALTH_FACTOR_LOW");
  });

  it("warns on high utilization and cap usage without enabling execution", () => {
    const report = evaluateLendingHealth(healthyPosition, [
      {
        protocolId: "lendle",
        marketId: "usdc",
        symbol: "USDC",
        utilizationBps: 9_250n,
        supplyCapUsedBps: 9_700n,
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.status).toBe("watch");
    expect(report.executionEnabled).toBe(false);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual([
      "LENDING_MARKET_UTILIZATION_HIGH",
      "LENDING_CAP_USAGE_HIGH",
    ]);
  });
});
