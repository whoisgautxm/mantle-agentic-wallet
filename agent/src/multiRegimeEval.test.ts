import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { planToDecision } from "./protocols/types.js";
import {
  createOfflineBenchmarkDecisionRunner,
  loadMultiRegimeFixture,
  rateLimitDelayMs,
  runMultiRegimeBenchmark,
  writeMultiRegimeBenchmark,
  type BenchmarkDecisionRunner,
  type MultiRegimeFixture,
} from "./multiRegimeEval.js";

const fixture: MultiRegimeFixture = {
  version: 1,
  name: "test benchmark",
  initialPortfolio: { mnt: "1", token: "0" },
  baseline: { buyMnt: "0.02" },
  costs: { swapFeeBps: 30, slippageBps: 20, gasMnt: "0.0002" },
  vaultLimits: { spendPerTxMnt: "0.1", dailySpendMnt: "1" },
  regimes: [
    {
      id: "dip-recovery",
      label: "Dip recovery",
      description: "test",
      prices: ["2", "1.8", "2.1"],
    },
  ],
};

describe("multi-regime benchmark", () => {
  it("runs decisions without exposing future prices and deducts transaction costs", async () => {
    const historyLengths: number[] = [];
    const runner: BenchmarkDecisionRunner = async ({ tickIndex, state, priceHistory, adapter }) => {
      historyLengths.push(priceHistory.length);
      if (tickIndex !== 1) return { kind: "hold", rationale: "wait" };
      const intent = { action: "buy" as const, amountMntWei: 5n * 10n ** 16n, rationale: "buy dip" };
      const quote = await adapter.quote(intent);
      return planToDecision(adapter.buildPlan(intent, quote), intent.rationale);
    };

    const report = await runMultiRegimeBenchmark(fixture, runner);
    const ai = report.regimes[0].ai;

    expect(report.ok).toBe(true);
    expect(historyLengths).toEqual([1, 2, 3]);
    expect(ai.executed).toBe(1);
    expect(BigInt(ai.totalCostsWei)).toBeGreaterThan(0n);
    expect(BigInt(ai.netRoiBps)).toBeLessThan(BigInt(ai.grossRoiBps));
    expect(report.aggregate.modelErrors).toBe(0);
    expect(report.regimes[0].comparators.dca.runner).toBe("dca");
    expect(report.regimes[0].comparators.momentum.ticks).toBe(3);
  });

  it("records risk-blocked oversized actions instead of settling them", async () => {
    const runner: BenchmarkDecisionRunner = async ({ adapter }) => ({
      kind: "execute",
      action: "buy",
      target: adapter.target,
      valueWei: 5n * 10n ** 17n,
      calldata: adapter.buildPlan(
        { action: "buy", amountMntWei: 5n * 10n ** 17n, rationale: "oversized" },
        { protocolId: "mockdex", priceWei: 2n * 10n ** 18n },
      ).calldata,
      rationale: "oversized",
    });

    const report = await runMultiRegimeBenchmark(fixture, runner);
    const ai = report.regimes[0].ai;

    expect(ai.executed).toBe(0);
    expect(ai.blocked).toBe(3);
    expect(ai.timeline.every((tick) => tick.ruleId === "POLICY_PRECHECK")).toBe(true);
  });

  it("loads the tracked fixture and writes a replayable JSON report", async () => {
    const tracked = await loadMultiRegimeFixture(path.join("evals", "market-regimes.json"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "multi-regime-eval-"));
    const outputPath = path.join(outputDir, "latest.json");
    const report = await runMultiRegimeBenchmark(tracked, createOfflineBenchmarkDecisionRunner());

    await writeMultiRegimeBenchmark(report, outputPath);
    const written = JSON.parse(await readFile(outputPath, "utf8"));

    expect(tracked.regimes).toHaveLength(4);
    expect(written.aggregate.regimes).toBe(4);
    expect(written.regimes[0].ai.timeline.length).toBeGreaterThan(0);
    expect(written.regimes[0].ai.timeline.some((tick: any) => tick.analysis?.marketFeatures)).toBe(true);
  });

  it("honors API retry hints when rate limited", () => {
    const error = new Error("Please try again in 2.5s.");
    expect(rateLimitDelayMs(error, 0)).toBe(3_000);
    expect(rateLimitDelayMs(new Error("Please try again in 250ms."), 0)).toBe(750);
    expect(rateLimitDelayMs(new Error("rate limited"), 0)).toBe(65_000);
  });
});
