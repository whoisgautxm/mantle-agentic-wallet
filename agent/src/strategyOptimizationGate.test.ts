import { describe, expect, it } from "vitest";
import {
  evaluateStrategyPromotion,
  type StrategyPromotionThresholds,
} from "./strategyOptimizationGate.js";
import type { StrategyOptimizationReport } from "./strategyOptimizationEval.js";

const thresholds: StrategyPromotionThresholds = {
  minCompositeDeltaBps: 1,
  minNetRoiDeltaBps: -5,
  maxDrawdownRegressionBps: 25,
  maxFixtureNetRoiRegressionBps: 20,
  maxDcaWinRegression: 3,
  minDcaEdgeBps: 1,
  minMomentumEdgeBps: 0,
};

function report(overrides: {
  composite?: number;
  netRoi?: number;
  drawdown?: number;
  fixtureNetRoi?: number;
  dcaWins?: number;
  dcaEdge?: number;
  momentumEdge?: number;
} = {}): StrategyOptimizationReport {
  const netRoi = overrides.netRoi ?? 60;
  return {
    schemaVersion: 1,
    phase: "development",
    generatedAt: "2026-06-09T00:00:00.000Z",
    ok: true,
    fixtureCount: 1,
    totalRegimes: 20,
    aggregate: {
      aiAverageNetRoiBps: String(netRoi),
      aiAverageCompositeScoreBps: String(overrides.composite ?? 50),
      aiWorstDrawdownBps: String(overrides.drawdown ?? -100),
      modelErrors: 0,
      comparatorAverageNetRoiBps: {
        dca: "-40",
        momentum: "20",
        "mean-reversion": "-10",
        hold: "0",
        "buy-and-hold": "5",
        "deterministic-ensemble": "50",
      },
      aiAverageEdgeByComparatorBps: {
        dca: String(overrides.dcaEdge ?? netRoi + 40),
        momentum: String(overrides.momentumEdge ?? netRoi - 20),
        "mean-reversion": String(netRoi + 10),
        hold: String(netRoi),
        "buy-and-hold": String(netRoi - 5),
        "deterministic-ensemble": String(netRoi - 50),
      },
      aiWinsByComparator: {
        dca: overrides.dcaWins ?? 18,
        momentum: 12,
        "mean-reversion": 15,
        hold: 10,
        "buy-and-hold": 11,
        "deterministic-ensemble": 10,
      },
    },
    fixtures: [
      {
        fixture: "evals/development.json",
        regimes: 20,
        ok: true,
        aiAverageNetRoiBps: String(overrides.fixtureNetRoi ?? netRoi),
        aiAverageCompositeScoreBps: String(overrides.composite ?? 50),
        aiWorstDrawdownBps: String(overrides.drawdown ?? -100),
        modelErrors: 0,
        comparatorAverageNetRoiBps: {
          dca: "-40",
          momentum: "20",
          "mean-reversion": "-10",
          hold: "0",
          "buy-and-hold": "5",
          "deterministic-ensemble": "50",
        },
        aiWinsByComparator: {
          dca: overrides.dcaWins ?? 18,
          momentum: 12,
          "mean-reversion": 15,
          hold: 10,
          "buy-and-hold": 11,
          "deterministic-ensemble": 10,
        },
      },
    ],
  };
}

describe("strategy optimization promotion gate", () => {
  it("accepts a focused improvement that preserves safety and comparator edges", () => {
    const gate = evaluateStrategyPromotion(
      report(),
      report({ composite: 55, netRoi: 63, fixtureNetRoi: 63 }),
      thresholds,
    );
    expect(gate.passed).toBe(true);
    expect(gate.deltas.compositeScoreBps).toBe(5);
  });

  it("rejects an overfit candidate with a large fixture regression", () => {
    const gate = evaluateStrategyPromotion(
      report(),
      report({ composite: 55, netRoi: 62, fixtureNetRoi: 20 }),
      thresholds,
    );
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((check) => check.id === "per-fixture-roi-preserved")?.passed).toBe(false);
  });

  it("rejects a candidate that improves return by taking too much drawdown", () => {
    const gate = evaluateStrategyPromotion(
      report(),
      report({ composite: 60, netRoi: 70, drawdown: -140 }),
      thresholds,
    );
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((check) => check.id === "drawdown-preserved")?.passed).toBe(false);
  });
});
