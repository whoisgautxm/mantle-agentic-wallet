import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { evaluateScenario, evaluateScenarios, loadScenarios, runScenarioEval, type ScenarioInput } from "./scenarioEval.js";

const target = "0x1111111111111111111111111111111111111111" as const;

const baseScenario: ScenarioInput = {
  name: "safe-buy",
  target,
  state: {
    balanceWei: "10000000000000000000",
    spendLimitPerTx: "1000000000000000000",
    dailyLimit: "2000000000000000000",
    spentToday: "0",
    windowStart: "1",
    paused: false,
    tokenBalanceWei: "0",
    priceWei: "2000000000000000000",
  },
  decision: {
    kind: "buy",
    valueWei: "100000000000000000",
  },
  oracle: {
    pair: "MNT/MOCK",
    priceWei: "2000000000000000000",
    source: "mockdex",
    updatedAt: "1",
    stale: false,
    maxAgeSeconds: "300",
  },
  simulation: { ok: true },
  limits: {
    maxDexOracleDeviationBps: "300",
    maxPositionBps: "7000",
    maxTradeValueBps: "2500",
  },
  expected: { ok: true },
};

describe("scenario eval", () => {
  it("passes a safe buy scenario", () => {
    const result = evaluateScenario(baseScenario);
    expect(result.ok).toBe(true);
    expect(result.actual.ok).toBe(true);
  });

  it("matches expected blocking rule ids", () => {
    const result = evaluateScenario({
      ...baseScenario,
      name: "stale-oracle",
      oracle: { ...baseScenario.oracle!, stale: true },
      expected: { ok: false, ruleId: "ORACLE_STALE" },
    });

    expect(result.ok).toBe(true);
    expect(result.actual.ok).toBe(false);
    if (!result.actual.ok) expect(result.actual.ruleId).toBe("ORACLE_STALE");
  });

  it("fails when actual risk does not match expectation", () => {
    const summary = evaluateScenarios([{ ...baseScenario, expected: { ok: false, ruleId: "SIMULATION_FAILED" } }]);
    expect(summary.ok).toBe(false);
    expect(summary.failed).toBe(1);
  });

  it("loads scenarios from disk and writes a summary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scenario-eval-"));
    const output = path.join(dir, "summary.json");
    await writeFile(path.join(dir, "safe-buy.json"), JSON.stringify(baseScenario));

    const scenarios = await loadScenarios(dir);
    const summary = await runScenarioEval(dir, output);
    const written = JSON.parse(await readFile(output, "utf8"));

    expect(scenarios).toHaveLength(1);
    expect(summary.ok).toBe(true);
    expect(written.passed).toBe(1);
  });
});
