import { describe, expect, it } from "vitest";
import {
  assessSimulationScenario,
  formatMerchantMoeAdversarialSuite,
  summarizeMerchantMoeAdversarialSuite,
  type MerchantMoeAdversarialScenario,
} from "./merchantMoeAdversarialFixture.js";
import type { MerchantMoeForkSimulationReport } from "./merchantMoeForkSimulation.js";
import type { MerchantMoeQuote } from "./protocols/merchantMoeReadOnlyAdapter.js";

const vault = "0x1111111111111111111111111111111111111111" as const;
const quote: MerchantMoeQuote = {
  protocolId: "merchant-moe",
  chainId: 5000,
  quoter: "0x2222222222222222222222222222222222222222",
  router: "0x3333333333333333333333333333333333333333",
  route: [
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
  ],
  pairs: [],
  binSteps: [],
  versions: [],
  amounts: [1000n, 900n],
  virtualAmountsWithoutSlippage: [],
  fees: [],
  amountIn: 1000n,
  amountOut: 900n,
};

describe("Merchant Moe adversarial fixture", () => {
  it("passes a scenario only when the expected blocker stops the expected stage", () => {
    const report = {
      ok: false,
      simulationAttempted: false,
      findings: [
        {
          ruleId: "ROUTER_ALLOWANCE_UNSAFE",
          severity: "blocker",
          reason: "guarded execution requires a bounded approval",
        },
      ],
    } as MerchantMoeForkSimulationReport;

    const scenario = assessSimulationScenario({
      id: "unsafe-allowance",
      label: "Unbounded router allowance",
      stage: "preflight",
      expectedRuleId: "ROUTER_ALLOWANCE_UNSAFE",
      report,
      simulationAttempted: false,
      vault,
      setupTransactionHashes: [],
    });

    expect(scenario.passed).toBe(true);
    expect(scenario.swapTransactionSubmitted).toBe(false);
  });

  it("summarizes and formats a fully blocked suite", () => {
    const base: Omit<MerchantMoeAdversarialScenario, "id" | "label"> = {
      stage: "simulation",
      expectedRuleId: "SIMULATION_FAILED",
      observedRuleId: "SIMULATION_FAILED",
      passed: true,
      simulationAttempted: true,
      swapTransactionSubmitted: false,
      reason: "paused",
      vault,
      setupTransactionHashes: [],
    };
    const scenarios: MerchantMoeAdversarialScenario[] = [
      { ...base, id: "paused-vault", label: "Paused vault" },
      {
        ...base,
        id: "unsafe-allowance",
        label: "Unsafe allowance",
        stage: "preflight",
        expectedRuleId: "ROUTER_ALLOWANCE_UNSAFE",
        observedRuleId: "ROUTER_ALLOWANCE_UNSAFE",
        simulationAttempted: false,
      },
    ];

    const report = summarizeMerchantMoeAdversarialSuite(123n, quote, scenarios);

    expect(report.ok).toBe(true);
    expect(report.passedScenarios).toBe(2);
    expect(report.noUnsafeSwapTransactionsSubmitted).toBe(true);
    expect(formatMerchantMoeAdversarialSuite(report)).toContain("2/2 passed");
  });
});
