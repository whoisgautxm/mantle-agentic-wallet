import { describe, expect, it } from "vitest";
import { evaluateMerchantMoeLiveCaps, type MerchantMoeLiveCapReportInput } from "./merchantMoeLiveCaps.js";

const passingReport: MerchantMoeLiveCapReportInput = {
  ok: true,
  fixtureKind: "anvil-mainnet-fork",
  simulationMode: "vault-execute",
  simulationPassed: true,
  calldataSource: "auto",
  amountIn: "1000",
  minOutWei: "890",
  slippageBps: "100",
  valueWei: "0",
  quoteRisk: {
    status: "ok",
    deviationBps: "10",
    maxDeviationBps: "300",
    reason: "quote/reference deviation 10 bps is within 300 bps",
  },
  preflight: {
    requiredAmountIn: "1000",
    allowanceRaw: "1000",
    allowanceStatus: "bounded",
    balanceOk: true,
    allowanceOk: true,
  },
  vaultEvidence: {
    paused: false,
    tokenAllowed: true,
    routerAllowed: true,
    routerGuarded: true,
  },
  forkExecution: {
    attempted: true,
    passed: true,
    vaultFunction: "executeGuarded",
    tokenOutDelta: "900",
    agentDecisionEvents: 1,
  },
};

const boundedEnv = {
  MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI: "1000",
  MERCHANT_MOE_LIVE_MAX_SLIPPAGE_BPS: "100",
  MERCHANT_MOE_LIVE_MAX_DEVIATION_BPS: "300",
  MERCHANT_MOE_LIVE_MAX_ALLOWANCE_MULTIPLE_BPS: "10000",
};

describe("Merchant Moe live caps", () => {
  it("stays disabled when explicit cap env values are missing", () => {
    const report = evaluateMerchantMoeLiveCaps(passingReport, {});

    expect(report.status).toBe("disabled");
    expect(report.eligible).toBe(false);
    expect(report.executionEnabled).toBe(false);
    expect(report.blockers.map((entry) => entry.ruleId)).toContain("MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI_MISSING");
    expect(report.blockers.map((entry) => entry.ruleId)).toContain("MERCHANT_MOE_LIVE_MAX_SLIPPAGE_BPS_MISSING");
  });

  it("is ready-disabled when every cap passes but the live switch is off", () => {
    const report = evaluateMerchantMoeLiveCaps(passingReport, boundedEnv);

    expect(report.status).toBe("ready-disabled");
    expect(report.eligible).toBe(true);
    expect(report.executionEnabled).toBe(false);
    expect(report.reason).toContain("MERCHANT_MOE_LIVE_EXECUTION_ENABLED is false");
  });

  it("becomes eligible only when caps pass and the explicit live switch is enabled", () => {
    const report = evaluateMerchantMoeLiveCaps(passingReport, {
      ...boundedEnv,
      MERCHANT_MOE_LIVE_EXECUTION_ENABLED: "true",
    });

    expect(report.status).toBe("eligible");
    expect(report.eligible).toBe(true);
    expect(report.executionEnabled).toBe(true);
  });

  it("blocks an enabled live policy when amountIn exceeds the cap", () => {
    const report = evaluateMerchantMoeLiveCaps(passingReport, {
      ...boundedEnv,
      MERCHANT_MOE_LIVE_EXECUTION_ENABLED: "true",
      MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI: "999",
    });

    expect(report.status).toBe("blocked");
    expect(report.executionEnabled).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        ruleId: "MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI_EXCEEDED",
      }),
    );
  });
});
