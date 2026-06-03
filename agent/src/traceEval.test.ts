import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { evaluateTraceEvents, parseJsonlTrace, runTraceEval } from "./traceEval.js";

const tickId = "tick-1";

function event(type: string, data: Record<string, unknown>) {
  return { ts: "2026-06-03T00:00:00.000Z", type, tickId, runner: "ai", ...data };
}

describe("trace eval", () => {
  it("parses JSONL trace events", () => {
    const events = parseJsonlTrace('{"type":"a"}\n\n{"type":"b"}\n');
    expect(events.map((item) => item.type)).toEqual(["a", "b"]);
  });

  it("passes an executed tick with passing risk and simulation", () => {
    const summary = evaluateTraceEvents([
      event("agent.simulation", { simulation: { ok: true } }),
      event("agent.risk", { risk: { ok: true, warnings: [] } }),
      event("agent.final_action", { outcome: "executed", txHash: "0xabc" }),
    ]);

    expect(summary.ok).toBe(true);
    expect(summary.executed).toBe(1);
    expect(summary.findings).toEqual([]);
  });

  it("fails when a failed risk result is not blocked", () => {
    const summary = evaluateTraceEvents([
      event("agent.simulation", { simulation: { ok: true } }),
      event("agent.risk", { risk: { ok: false, reason: "stale oracle" } }),
      event("agent.final_action", { outcome: "hold" }),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.findings.map((item) => item.ruleId)).toContain("FAILED_RISK_NOT_BLOCKED");
  });

  it("fails when execution lacks a passing simulation", () => {
    const summary = evaluateTraceEvents([
      event("agent.risk", { risk: { ok: true, warnings: [] } }),
      event("agent.final_action", { outcome: "executed" }),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.findings.map((item) => item.ruleId)).toContain("EXECUTED_WITHOUT_PASSING_SIMULATION");
  });

  it("fails when a stale oracle tick executes", () => {
    const summary = evaluateTraceEvents([
      event("agent.observation", { oracle: { stale: true } }),
      event("agent.simulation", { simulation: { ok: true } }),
      event("agent.risk", { risk: { ok: true, warnings: [] } }),
      event("agent.final_action", { outcome: "executed" }),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.findings.map((item) => item.ruleId)).toContain("EXECUTED_WITH_STALE_ORACLE");
  });

  it("writes optional eval output JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trace-eval-"));
    const input = path.join(dir, "events.jsonl");
    const output = path.join(dir, "summary.json");
    await writeFile(
      input,
      [
        JSON.stringify(event("agent.simulation", { simulation: { ok: true } })),
        JSON.stringify(event("agent.risk", { risk: { ok: true, warnings: [] } })),
        JSON.stringify(event("agent.final_action", { outcome: "executed" })),
      ].join("\n"),
    );

    const summary = await runTraceEval(input, output);
    const written = JSON.parse(await readFile(output, "utf8"));
    expect(summary.ok).toBe(true);
    expect(written.executed).toBe(1);
  });
});
