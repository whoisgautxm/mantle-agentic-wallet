import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import type {
  StrategyOptimizationFixtureScore,
  StrategyOptimizationReport,
} from "./strategyOptimizationEval.js";

export interface StrategyPromotionThresholds {
  minCompositeDeltaBps: number;
  minNetRoiDeltaBps: number;
  maxDrawdownRegressionBps: number;
  maxFixtureNetRoiRegressionBps: number;
  maxDcaWinRegression: number;
  minDcaEdgeBps: number;
  minMomentumEdgeBps: number;
}

export interface StrategyPromotionGate {
  passed: boolean;
  phase: StrategyOptimizationReport["phase"];
  deltas: {
    compositeScoreBps: number;
    netRoiBps: number;
    drawdownRegressionBps: number;
    dcaWinRegression: number;
  };
  checks: Array<{
    id: string;
    passed: boolean;
    detail: string;
  }>;
}

const DEFAULT_THRESHOLDS: StrategyPromotionThresholds = {
  minCompositeDeltaBps: 1,
  minNetRoiDeltaBps: -5,
  maxDrawdownRegressionBps: 25,
  maxFixtureNetRoiRegressionBps: 20,
  maxDcaWinRegression: 3,
  minDcaEdgeBps: 1,
  minMomentumEdgeBps: 0,
};

function numeric(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid numeric score: ${value}`);
  return parsed;
}

function fixtureByName(
  report: StrategyOptimizationReport,
): Map<string, StrategyOptimizationFixtureScore> {
  return new Map(report.fixtures.map((fixture) => [fixture.fixture, fixture]));
}

export function evaluateStrategyPromotion(
  baseline: StrategyOptimizationReport,
  candidate: StrategyOptimizationReport,
  thresholds: StrategyPromotionThresholds = DEFAULT_THRESHOLDS,
): StrategyPromotionGate {
  if (baseline.phase !== candidate.phase) {
    throw new Error(`phase mismatch: baseline=${baseline.phase}, candidate=${candidate.phase}`);
  }

  const compositeDelta =
    numeric(candidate.aggregate.aiAverageCompositeScoreBps) -
    numeric(baseline.aggregate.aiAverageCompositeScoreBps);
  const netRoiDelta =
    numeric(candidate.aggregate.aiAverageNetRoiBps) -
    numeric(baseline.aggregate.aiAverageNetRoiBps);
  const drawdownRegression =
    numeric(baseline.aggregate.aiWorstDrawdownBps) -
    numeric(candidate.aggregate.aiWorstDrawdownBps);
  const dcaWinRegression =
    baseline.aggregate.aiWinsByComparator.dca -
    candidate.aggregate.aiWinsByComparator.dca;
  const baselineFixtures = fixtureByName(baseline);
  const fixtureRegressions = candidate.fixtures
    .map((fixture) => {
      const baselineFixture = baselineFixtures.get(fixture.fixture);
      if (!baselineFixture) {
        return {
          fixture: fixture.fixture,
          regressionBps: Number.POSITIVE_INFINITY,
        };
      }
      return {
        fixture: fixture.fixture,
        regressionBps:
          numeric(baselineFixture.aiAverageNetRoiBps) -
          numeric(fixture.aiAverageNetRoiBps),
      };
    });
  const worstFixtureRegression = fixtureRegressions.reduce(
    (worst, fixture) => Math.max(worst, fixture.regressionBps),
    0,
  );

  const checks: StrategyPromotionGate["checks"] = [
    {
      id: "candidate-ok",
      passed: candidate.ok && candidate.aggregate.modelErrors === 0,
      detail: `candidate ok=${candidate.ok}, modelErrors=${candidate.aggregate.modelErrors}`,
    },
    {
      id: "fixture-set-matches",
      passed:
        baseline.fixtures.length === candidate.fixtures.length &&
        candidate.fixtures.every((fixture) => baselineFixtures.has(fixture.fixture)),
      detail: `baseline fixtures=${baseline.fixtures.length}, candidate fixtures=${candidate.fixtures.length}`,
    },
    {
      id: "composite-improves",
      passed: compositeDelta >= thresholds.minCompositeDeltaBps,
      detail: `delta=${compositeDelta} bps, required>=${thresholds.minCompositeDeltaBps}`,
    },
    {
      id: "net-roi-preserved",
      passed: netRoiDelta >= thresholds.minNetRoiDeltaBps,
      detail: `delta=${netRoiDelta} bps, required>=${thresholds.minNetRoiDeltaBps}`,
    },
    {
      id: "drawdown-preserved",
      passed: drawdownRegression <= thresholds.maxDrawdownRegressionBps,
      detail: `regression=${drawdownRegression} bps, allowed<=${thresholds.maxDrawdownRegressionBps}`,
    },
    {
      id: "per-fixture-roi-preserved",
      passed: worstFixtureRegression <= thresholds.maxFixtureNetRoiRegressionBps,
      detail: `worst regression=${worstFixtureRegression} bps, allowed<=${thresholds.maxFixtureNetRoiRegressionBps}`,
    },
    {
      id: "dca-win-rate-preserved",
      passed: dcaWinRegression <= thresholds.maxDcaWinRegression,
      detail: `win regression=${dcaWinRegression}, allowed<=${thresholds.maxDcaWinRegression}`,
    },
    {
      id: "dca-edge-positive",
      passed:
        numeric(candidate.aggregate.aiAverageEdgeByComparatorBps.dca) >=
        thresholds.minDcaEdgeBps,
      detail: `edge=${candidate.aggregate.aiAverageEdgeByComparatorBps.dca} bps, required>=${thresholds.minDcaEdgeBps}`,
    },
    {
      id: "momentum-edge-positive",
      passed:
        numeric(candidate.aggregate.aiAverageEdgeByComparatorBps.momentum) >=
        thresholds.minMomentumEdgeBps,
      detail: `edge=${candidate.aggregate.aiAverageEdgeByComparatorBps.momentum} bps, required>=${thresholds.minMomentumEdgeBps}`,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    phase: candidate.phase,
    deltas: {
      compositeScoreBps: compositeDelta,
      netRoiBps: netRoiDelta,
      drawdownRegressionBps: drawdownRegression,
      dcaWinRegression,
    },
    checks,
  };
}

function thresholdFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

async function loadReport(filePath: string): Promise<StrategyOptimizationReport> {
  return JSON.parse(await readFile(filePath, "utf8")) as StrategyOptimizationReport;
}

export async function main(): Promise<void> {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error("usage: strategyOptimizationGate.ts <baseline.json> <candidate.json>");
  }
  const gate = evaluateStrategyPromotion(
    await loadReport(baselinePath),
    await loadReport(candidatePath),
    {
      minCompositeDeltaBps: thresholdFromEnv(
        "OPTIMIZER_MIN_COMPOSITE_DELTA_BPS",
        DEFAULT_THRESHOLDS.minCompositeDeltaBps,
      ),
      minNetRoiDeltaBps: thresholdFromEnv(
        "OPTIMIZER_MIN_NET_ROI_DELTA_BPS",
        DEFAULT_THRESHOLDS.minNetRoiDeltaBps,
      ),
      maxDrawdownRegressionBps: thresholdFromEnv(
        "OPTIMIZER_MAX_DRAWDOWN_REGRESSION_BPS",
        DEFAULT_THRESHOLDS.maxDrawdownRegressionBps,
      ),
      maxFixtureNetRoiRegressionBps: thresholdFromEnv(
        "OPTIMIZER_MAX_FIXTURE_ROI_REGRESSION_BPS",
        DEFAULT_THRESHOLDS.maxFixtureNetRoiRegressionBps,
      ),
      maxDcaWinRegression: thresholdFromEnv(
        "OPTIMIZER_MAX_DCA_WIN_REGRESSION",
        DEFAULT_THRESHOLDS.maxDcaWinRegression,
      ),
      minDcaEdgeBps: thresholdFromEnv(
        "OPTIMIZER_MIN_DCA_EDGE_BPS",
        DEFAULT_THRESHOLDS.minDcaEdgeBps,
      ),
      minMomentumEdgeBps: thresholdFromEnv(
        "OPTIMIZER_MIN_MOMENTUM_EDGE_BPS",
        DEFAULT_THRESHOLDS.minMomentumEdgeBps,
      ),
    },
  );
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[strategy-optimization-gate] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
