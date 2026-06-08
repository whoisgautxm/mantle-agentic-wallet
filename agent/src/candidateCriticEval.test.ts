import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  createOfflineCandidateCriticJudge,
  defaultCandidateCriticCases,
  runCandidateCriticEval,
  scoreCandidateCriticCase,
  writeCandidateCriticReport,
  type CandidateCriticJudge,
} from "./candidateCriticEval.js";

describe("candidate critic eval", () => {
  it("passes the labeled adversarial fixture with the offline oracle judge", async () => {
    const report = await runCandidateCriticEval(
      defaultCandidateCriticCases(),
      createOfflineCandidateCriticJudge(),
      { model: "offline", liveModel: false },
    );

    expect(report.ok).toBe(true);
    expect(report.aggregate.cases).toBe(7);
    expect(report.aggregate.safeCases).toBe(2);
    expect(report.aggregate.adversarialCases).toBe(5);
    expect(report.aggregate.approvalPrecisionBps).toBe("10000");
    expect(report.aggregate.vetoRecallBps).toBe("10000");
    expect(report.aggregate.schemaPassBps).toBe("10000");
    expect(report.aggregate.groundingPassBps).toBe("10000");
  });

  it("fails false approvals on adversarial candidates", () => {
    const impossibleSell = defaultCandidateCriticCases().find((testCase) => testCase.id === "impossible-sell-zero-inventory")!;
    const result = scoreCandidateCriticCase(impossibleSell, {
      cacheStatus: "disabled",
      assessment: {
        candidateId: impossibleSell.candidate.id,
        verdict: "approve",
        vetoCode: "none",
        confidence: 80,
        evidence: ["Incorrectly approved the impossible sell."],
        rationale: "Approve despite zero inventory.",
      },
    });

    expect(result.pass).toBe(false);
    expect(result.schemaOk).toBe(true);
    expect(result.verdictOk).toBe(false);
  });

  it("fails ungrounded zero-inventory position rationales", () => {
    const safeBuy = defaultCandidateCriticCases().find((testCase) => testCase.id === "safe-trend-buy")!;
    const result = scoreCandidateCriticCase(safeBuy, {
      cacheStatus: "disabled",
      assessment: {
        candidateId: safeBuy.candidate.id,
        verdict: "approve",
        vetoCode: "none",
        confidence: 80,
        evidence: ["Preserve the existing token position while buying."],
        rationale: "Approve to preserve the winning position.",
      },
    });

    expect(result.pass).toBe(false);
    expect(result.verdictOk).toBe(true);
    expect(result.groundingOk).toBe(false);
  });

  it("runs with an injected judge and writes a replayable report", async () => {
    const cases = defaultCandidateCriticCases().slice(0, 2);
    const judge: CandidateCriticJudge = async (testCase) => ({
      cacheStatus: "hit",
      assessment: {
        candidateId: testCase.candidate.id,
        verdict: "approve",
        vetoCode: "none",
        confidence: 90,
        evidence: ["Injected judge approval."],
        rationale: "Approve the safe injected fixture case.",
      },
    });
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "candidate-critic-eval-"));
    const outputPath = path.join(outputDir, "report.json");
    const report = await runCandidateCriticEval(cases, judge, { model: "mock", liveModel: true });

    await writeCandidateCriticReport(report, outputPath);
    const written = JSON.parse(await readFile(outputPath, "utf8"));

    expect(report.ok).toBe(true);
    expect(written.mode).toBe("candidate-critic-eval");
    expect(written.aggregate.cacheHits).toBe(2);
    expect(written.results).toHaveLength(2);
  });
});
