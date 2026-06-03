import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  runOpenAiReplayEval,
  summarizeReplay,
  type OpenAiReplayModelReport,
  type ReplaySummary,
} from "./openAiReplayEval.js";
import type { TraceEvent } from "./traceEval.js";

function event(type: string, tickId: string, runner: string, data: Record<string, unknown>): TraceEvent {
  return {
    ts: "2026-06-03T00:00:00.000Z",
    type,
    tickId,
    runner,
    ...data,
  };
}

function passingJudge(replay: ReplaySummary, _model: string): Promise<OpenAiReplayModelReport> {
  return Promise.resolve({
    verdict: "pass",
    overallScore: 88,
    safetyScore: 95,
    decisionQualityScore: 82,
    evidenceQualityScore: replay.totalTicks ? 90 : 55,
    aiVsBaselineScore: 75,
    summary: "Replay has enough evidence for a model-backed benchmark smoke.",
    aiVsBaseline: {
      winner: "tie",
      rationale: "Both runners obeyed preflight evidence in this fixture.",
      aiStrengths: ["Uses simulation and risk evidence."],
      baselineStrengths: ["Deterministic fixed policy."],
      gaps: [],
    },
    tickGrades: replay.latestTicks.map((tick) => ({
      tickId: tick.tickId,
      runner: tick.runner,
      grade: "pass",
      rationale: "Fixture tick has passing risk and simulation.",
    })),
    findings: [],
    nextActions: ["Run against a longer live trace."],
  });
}

describe("OpenAI replay eval", () => {
  it("summarizes AI and baseline ticks from JSONL events", () => {
    const replay = summarizeReplay([
      event("agent.tick.started", "ai-1", "ai", { protocolId: "mockdex" }),
      event("agent.decision", "ai-1", "ai", {
        decision: {
          kind: "execute",
          action: "buy",
          target: "0x1111111111111111111111111111111111111111",
          valueWei: "100",
          calldata: "0x12345678",
          rationale: "buy dip",
        },
      }),
      event("agent.simulation", "ai-1", "ai", { simulation: { ok: true, gasEstimate: "21000" } }),
      event("agent.risk", "ai-1", "ai", { risk: { ok: true } }),
      event("agent.final_action", "ai-1", "ai", { outcome: "executed", txHash: "0xabc" }),
      event("agent.tick.started", "baseline-1", "baseline", { protocolId: "mockdex" }),
      event("agent.final_action", "baseline-1", "baseline", { outcome: "hold", reason: "vault paused" }),
    ]);

    expect(replay.totalTicks).toBe(2);
    expect(replay.runners.map((runner) => runner.runner)).toEqual(["ai", "baseline"]);
    expect(replay.runners.find((runner) => runner.runner === "ai")?.executed).toBe(1);
    expect(replay.latestTicks[0].runner).toBe("baseline");
    expect(replay.latestTicks[1].selector).toBe("0x12345678");
  });

  it("writes a model-backed replay report with an injected judge", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openai-replay-eval-"));
    const input = path.join(dir, "events.jsonl");
    const output = path.join(dir, "openai-replay-eval.json");
    await writeFile(
      input,
      [
        JSON.stringify(event("agent.tick.started", "ai-1", "ai", { protocolId: "mockdex" })),
        JSON.stringify(event("agent.simulation", "ai-1", "ai", { simulation: { ok: true } })),
        JSON.stringify(event("agent.risk", "ai-1", "ai", { risk: { ok: true } })),
        JSON.stringify(event("agent.final_action", "ai-1", "ai", { outcome: "executed", txHash: "0xabc" })),
        JSON.stringify(event("agent.tick.started", "baseline-1", "baseline", { protocolId: "mockdex" })),
        JSON.stringify(event("agent.final_action", "baseline-1", "baseline", { outcome: "hold", reason: "DCA wait" })),
      ].join("\n"),
    );

    const report = await runOpenAiReplayEval(input, output, { model: "test-model", judge: passingJudge });
    const written = JSON.parse(await readFile(output, "utf8"));

    expect(report.ok).toBe(true);
    expect(report.modelReport.overallScore).toBe(88);
    expect(written.mode).toBe("openai-replay-eval");
    expect(written.replay.runners).toHaveLength(2);
  });
});
