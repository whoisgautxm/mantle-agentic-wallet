import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  createOfflineBenchmarkDecisionRunner,
  loadMultiRegimeFixture,
  runMultiRegimeBenchmark,
  type MultiRegimeBenchmarkReport,
} from "./multiRegimeEval.js";

export type StrategyOptimizationPhase = "development" | "heldout";

const DEFAULT_FIXTURES: Record<StrategyOptimizationPhase, readonly string[]> = {
  development: [
    "evals/gen-20260608/market-paths-development.json",
    "evals/gen-99999999/market-paths-development.json",
  ],
  heldout: [
    "evals/gen-20260608/market-paths-held-out.json",
    "evals/gen-99999999/market-paths-held-out.json",
  ],
};

type ComparatorName = keyof MultiRegimeBenchmarkReport["aggregate"]["comparatorAverageNetRoiBps"];

export interface StrategyOptimizationFixtureScore {
  fixture: string;
  regimes: number;
  ok: boolean;
  aiAverageNetRoiBps: string;
  aiAverageCompositeScoreBps: string;
  aiWorstDrawdownBps: string;
  modelErrors: number;
  comparatorAverageNetRoiBps: Record<ComparatorName, string>;
  aiWinsByComparator: Record<ComparatorName, number>;
}

export interface StrategyOptimizationReport {
  schemaVersion: 1;
  phase: StrategyOptimizationPhase;
  generatedAt: string;
  ok: boolean;
  fixtureCount: number;
  totalRegimes: number;
  aggregate: {
    aiAverageNetRoiBps: string;
    aiAverageCompositeScoreBps: string;
    aiWorstDrawdownBps: string;
    modelErrors: number;
    comparatorAverageNetRoiBps: Record<ComparatorName, string>;
    aiAverageEdgeByComparatorBps: Record<ComparatorName, string>;
    aiWinsByComparator: Record<ComparatorName, number>;
  };
  fixtures: StrategyOptimizationFixtureScore[];
}

function weightedAverage(
  reports: readonly MultiRegimeBenchmarkReport[],
  value: (report: MultiRegimeBenchmarkReport) => bigint,
): bigint {
  const weightedTotal = reports.reduce(
    (total, report) => total + value(report) * BigInt(report.aggregate.regimes),
    0n,
  );
  const regimes = reports.reduce((total, report) => total + report.aggregate.regimes, 0);
  return regimes ? weightedTotal / BigInt(regimes) : 0n;
}

function minimum(values: readonly bigint[]): bigint {
  if (!values.length) return 0n;
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

export function summarizeStrategyOptimizationReports(
  phase: StrategyOptimizationPhase,
  reports: readonly MultiRegimeBenchmarkReport[],
): StrategyOptimizationReport {
  const comparators = Object.keys(
    reports[0]?.aggregate.comparatorAverageNetRoiBps ?? {},
  ) as ComparatorName[];
  const aiAverageNetRoi = weightedAverage(
    reports,
    (report) => BigInt(report.aggregate.aiAverageNetRoiBps),
  );
  const comparatorAverageNetRoiBps = Object.fromEntries(
    comparators.map((comparator) => [
      comparator,
      weightedAverage(
        reports,
        (report) => BigInt(report.aggregate.comparatorAverageNetRoiBps[comparator]),
      ).toString(),
    ]),
  ) as Record<ComparatorName, string>;

  return {
    schemaVersion: 1,
    phase,
    generatedAt: new Date().toISOString(),
    ok: reports.length > 0 && reports.every((report) => report.ok),
    fixtureCount: reports.length,
    totalRegimes: reports.reduce((total, report) => total + report.aggregate.regimes, 0),
    aggregate: {
      aiAverageNetRoiBps: aiAverageNetRoi.toString(),
      aiAverageCompositeScoreBps: weightedAverage(
        reports,
        (report) => BigInt(report.aggregate.aiAverageCompositeScoreBps),
      ).toString(),
      aiWorstDrawdownBps: minimum(
        reports.map((report) => BigInt(report.aggregate.aiWorstDrawdownBps)),
      ).toString(),
      modelErrors: reports.reduce((total, report) => total + report.aggregate.modelErrors, 0),
      comparatorAverageNetRoiBps,
      aiAverageEdgeByComparatorBps: Object.fromEntries(
        comparators.map((comparator) => [
          comparator,
          (aiAverageNetRoi - BigInt(comparatorAverageNetRoiBps[comparator])).toString(),
        ]),
      ) as Record<ComparatorName, string>,
      aiWinsByComparator: Object.fromEntries(
        comparators.map((comparator) => [
          comparator,
          reports.reduce(
            (total, report) => total + report.aggregate.aiWinsByComparator[comparator],
            0,
          ),
        ]),
      ) as Record<ComparatorName, number>,
    },
    fixtures: reports.map((report) => ({
      fixture: report.fixture,
      regimes: report.aggregate.regimes,
      ok: report.ok,
      aiAverageNetRoiBps: report.aggregate.aiAverageNetRoiBps,
      aiAverageCompositeScoreBps: report.aggregate.aiAverageCompositeScoreBps,
      aiWorstDrawdownBps: report.aggregate.aiWorstDrawdownBps,
      modelErrors: report.aggregate.modelErrors,
      comparatorAverageNetRoiBps: report.aggregate.comparatorAverageNetRoiBps,
      aiWinsByComparator: report.aggregate.aiWinsByComparator,
    })),
  };
}

interface CliOptions {
  phase: StrategyOptimizationPhase;
  outputPath: string;
  fixtures: string[];
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const phaseValue = args.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length);
  const phase: StrategyOptimizationPhase =
    phaseValue === "heldout" ? "heldout" : "development";
  if (phaseValue && phaseValue !== "development" && phaseValue !== "heldout") {
    throw new Error(`unsupported optimization phase: ${phaseValue}`);
  }
  const outputPath =
    args.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ??
    path.join("traces", `strategy-optimization-${phase}.json`);
  const fixtureOverride = args
    .find((arg) => arg.startsWith("--fixtures="))
    ?.slice("--fixtures=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    phase,
    outputPath,
    fixtures: fixtureOverride?.length ? fixtureOverride : [...DEFAULT_FIXTURES[phase]],
  };
}

export async function runStrategyOptimizationSuite(
  options: CliOptions,
): Promise<StrategyOptimizationReport> {
  const reports: MultiRegimeBenchmarkReport[] = [];
  for (const fixturePath of options.fixtures) {
    const fixture = await loadMultiRegimeFixture(fixturePath);
    reports.push(
      await runMultiRegimeBenchmark(
        fixture,
        createOfflineBenchmarkDecisionRunner(),
        {
          fixturePath,
          liveModel: false,
          model: "regime-routed-ensemble",
        },
      ),
    );
  }
  return summarizeStrategyOptimizationReports(options.phase, reports);
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const report = await runStrategyOptimizationSuite(options);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[strategy-optimization-eval] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
