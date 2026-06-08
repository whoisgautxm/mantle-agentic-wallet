import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { planToDecision } from "./protocols/types.js";
import {
  createAiAssistedBenchmarkDecisionRunner,
  createOfflineBenchmarkDecisionRunner,
  createOpenAiCandidateAssessmentBenchmarkDecisionRunner,
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
    const runner: BenchmarkDecisionRunner = async ({ tickIndex, priceHistory, adapter }) => {
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
    expect(report.regimes[0].comparators["buy-and-hold"].runner).toBe("buy-and-hold");
    expect(report.regimes[0].comparators["deterministic-ensemble"].runner).toBe("deterministic-ensemble");
    expect(report.regimes[0].comparators.momentum.ticks).toBe(3);
    expect(ai.score.compositeScoreBps).toEqual(expect.any(String));
    expect(report.aggregate.comparatorAverageCompositeScoreBps.hold).toEqual(expect.any(String));
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
    expect(written.regimes[0].ai.timeline.some((tick: any) => tick.rationale.includes("Ensemble"))).toBe(true);
  });

  it("delegates the offline path to the injected strategy without future prices", async () => {
    const observedLengths: number[] = [];
    const runner = createOfflineBenchmarkDecisionRunner(({ priceHistory }) => {
      observedLengths.push(priceHistory.length);
      return {
        action: "hold",
        sizePercent: 0,
        expectedEdgeBps: 0,
        rationale: "custom strategy hold",
      };
    });

    const report = await runMultiRegimeBenchmark(fixture, runner);

    expect(observedLengths).toEqual([1, 2, 3]);
    expect(report.regimes[0].ai.timeline.every((tick) => tick.rationale === "custom strategy hold")).toBe(true);
  });

  it("runs the synchronized AI-assisted candidate assessment path", async () => {
    const risingFixture: MultiRegimeFixture = {
      ...fixture,
      regimes: [
        {
          id: "clear-rally",
          label: "Clear rally",
          description: "test",
          prices: ["2", "2.04", "2.09", "2.16", "2.25"],
        },
      ],
    };

    const report = await runMultiRegimeBenchmark(
      risingFixture,
      createAiAssistedBenchmarkDecisionRunner(),
      { model: "ai-assisted-ensemble-offline" },
    );
    const ai = report.regimes[0].ai;

    expect(report.model).toBe("ai-assisted-ensemble-offline");
    expect(ai.executed).toBeGreaterThan(0);
    expect(ai.timeline.some((tick) => tick.decisionMode === "candidate_assessment")).toBe(true);
    expect(ai.timeline.some((tick) => tick.candidateId)).toBe(true);
  });

  it("runs the live OpenAI candidate-assessment benchmark path with a mocked client", async () => {
    const calls: any[] = [];
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async (payload: any) => {
            calls.push(payload);
            const userContent = String(payload.input[1].content);
            const candidate = JSON.parse(userContent.match(/Candidate JSON: (.+)\n\nReturn/)?.[1] ?? "{}");
            return {
              output: [
                {
                  type: "function_call",
                  name: "assess_trade_candidate",
                  arguments: JSON.stringify({
                    candidateId: candidate.id,
                    verdict: "approve",
                    vetoCode: "none",
                    confidence: 88,
                    evidence: ["Candidate is grounded in observed trend and supplied vault state."],
                    rationale: "Approve the deterministic benchmark candidate.",
                  }),
                },
              ],
            };
          },
        },
      },
    };
    const report = await runMultiRegimeBenchmark(
      {
        ...fixture,
        regimes: [
          {
            id: "clear-rally",
            label: "Clear rally",
            description: "test",
            prices: ["2", "2.04", "2.09", "2.16", "2.25"],
          },
        ],
      },
      createOpenAiCandidateAssessmentBenchmarkDecisionRunner({
        client: client as any,
        model: "mock-openai",
        minimumIntervalMs: 0,
      }),
      { model: "openai-candidate-assessment:mock-openai", liveModel: true },
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.tools[0].name === "assess_trade_candidate")).toBe(true);
    expect(report.aggregate.modelAssessment.candidatesAssessed).toBe(calls.length);
    expect(report.aggregate.modelAssessment.approvals).toBe(calls.length);
    expect(report.aggregate.modelAssessment.approvalPrecisionBps).toBe("10000");
    expect(report.aggregate.incrementalValueGate.comparator).toBe("deterministic-ensemble");
  });

  it("reuses cached candidate assessments across benchmark runner instances", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "candidate-assessment-cache-"));
    const cachePath = path.join(outputDir, "cache.json");
    const calls: any[] = [];
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async (payload: any) => {
            calls.push(payload);
            const userContent = String(payload.input[1].content);
            const candidate = JSON.parse(userContent.match(/Candidate JSON: (.+)\n\nReturn/)?.[1] ?? "{}");
            return {
              output: [
                {
                  type: "function_call",
                  name: "assess_trade_candidate",
                  arguments: JSON.stringify({
                    candidateId: candidate.id,
                    verdict: "approve",
                    vetoCode: "none",
                    confidence: 90,
                    evidence: ["Cached assessment test evidence."],
                    rationale: "Approve for cache test.",
                  }),
                },
              ],
            };
          },
        },
      },
    };
    const risingFixture: MultiRegimeFixture = {
      ...fixture,
      regimes: [
        {
          id: "clear-rally",
          label: "Clear rally",
          description: "test",
          prices: ["2", "2.04", "2.09", "2.16", "2.25"],
        },
      ],
    };

    await runMultiRegimeBenchmark(
      risingFixture,
      createOpenAiCandidateAssessmentBenchmarkDecisionRunner({
        client: client as any,
        model: "mock-openai",
        minimumIntervalMs: 0,
        cachePath,
      }),
      { model: "openai-candidate-assessment:mock-openai", liveModel: true },
    );
    const callsAfterFirstRun = calls.length;
    const secondReport = await runMultiRegimeBenchmark(
      risingFixture,
      createOpenAiCandidateAssessmentBenchmarkDecisionRunner({
        client: client as any,
        model: "mock-openai",
        minimumIntervalMs: 0,
        cachePath,
      }),
      { model: "openai-candidate-assessment:mock-openai", liveModel: true },
    );

    expect(callsAfterFirstRun).toBeGreaterThan(0);
    expect(calls).toHaveLength(callsAfterFirstRun);
    expect(secondReport.aggregate.modelAssessment.cacheHits).toBe(callsAfterFirstRun);
    expect(secondReport.aggregate.modelAssessment.cacheMisses).toBe(0);
  });

  it("defers rate-limited candidate assessments without recording model errors", async () => {
    const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async () => {
            throw rateLimitError;
          },
        },
      },
    };
    const report = await runMultiRegimeBenchmark(
      {
        ...fixture,
        regimes: [
          {
            id: "clear-rally",
            label: "Clear rally",
            description: "test",
            prices: ["2", "2.04", "2.09", "2.16", "2.25"],
          },
        ],
      },
      createOpenAiCandidateAssessmentBenchmarkDecisionRunner({
        client: client as any,
        model: "mock-openai",
        maxRetries: 0,
        minimumIntervalMs: 0,
        deferRateLimit: true,
      }),
      { model: "openai-candidate-assessment:mock-openai", liveModel: true },
    );

    expect(report.ok).toBe(true);
    expect(report.aggregate.modelErrors).toBe(0);
    expect(report.aggregate.modelAssessment.providerRateLimitSkips).toBeGreaterThan(0);
    expect(report.regimes[0].ai.timeline.some((tick) => tick.providerRateLimitDeferred)).toBe(true);
  });

  it("can cap fresh live assessments per regime", async () => {
    const calls: any[] = [];
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async (payload: any) => {
            calls.push(payload);
            const userContent = String(payload.input[1].content);
            const candidate = JSON.parse(userContent.match(/Candidate JSON: (.+)\n\nReturn/)?.[1] ?? "{}");
            return {
              output: [
                {
                  type: "function_call",
                  name: "assess_trade_candidate",
                  arguments: JSON.stringify({
                    candidateId: candidate.id,
                    verdict: "approve",
                    vetoCode: "none",
                    confidence: 87,
                    evidence: ["Budget test evidence."],
                    rationale: "Approve the first candidate only.",
                  }),
                },
              ],
            };
          },
        },
      },
    };
    const report = await runMultiRegimeBenchmark(
      {
        ...fixture,
        regimes: [
          {
            id: "clear-rally",
            label: "Clear rally",
            description: "test",
            prices: ["2", "2.04", "2.09", "2.16", "2.25"],
          },
        ],
      },
      createOpenAiCandidateAssessmentBenchmarkDecisionRunner({
        client: client as any,
        model: "mock-openai",
        minimumIntervalMs: 0,
        maxAssessmentsPerRegime: 1,
      }),
      { model: "openai-candidate-assessment:mock-openai", liveModel: true },
    );

    expect(calls).toHaveLength(1);
    expect(report.aggregate.modelAssessment.candidatesAssessed).toBe(1);
    expect(report.aggregate.modelAssessment.assessmentBudgetSkips).toBeGreaterThan(0);
    expect(report.regimes[0].ai.timeline.some((tick) => tick.modelAssessmentError === "assessment_budget_exhausted")).toBe(true);
  });

  it("honors API retry hints when rate limited", () => {
    const error = new Error("Please try again in 2.5s.");
    expect(rateLimitDelayMs(error, 0)).toBe(3_000);
    expect(rateLimitDelayMs(new Error("Please try again in 250ms."), 0)).toBe(750);
    expect(rateLimitDelayMs(new Error("rate limited"), 0)).toBe(65_000);
  });
});
