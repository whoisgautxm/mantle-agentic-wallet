import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { formatLendingReadiness, parseLendingReadinessInput, runLendingReadiness } from "./lendingReadiness.js";
import { evaluateLendingHealth } from "./protocols/lending/health.js";
import { createJsonlTraceWriter } from "./tracing.js";

const account = "0x1111111111111111111111111111111111111111";

const positionJson = JSON.stringify({
  protocolId: "lendle",
  account,
  assets: [
    {
      symbol: "USDC",
      suppliedValueWei: "1000000000000000000000",
      debtValueWei: "250000000000000000000",
      liquidationThresholdBps: "8000",
    },
  ],
});

describe("lending readiness", () => {
  it("parses position, market, and limit env inputs", () => {
    const input = parseLendingReadinessInput({
      LENDING_POSITION_JSON: positionJson,
      LENDING_MARKETS_JSON: JSON.stringify([
        {
          marketId: "usdc",
          symbol: "USDC",
          utilizationBps: "8500",
          paused: false,
        },
      ]),
      LENDING_MIN_HEALTH_FACTOR_BPS: "16000",
    });

    expect(input.position.protocolId).toBe("lendle");
    expect(input.position.account).toBe(account);
    expect(input.markets[0].utilizationBps).toBe(8_500n);
    expect(input.limits.minHealthFactorBps).toBe(16_000n);
  });

  it("formats a read-only no-execution report", () => {
    const report = evaluateLendingHealth(parseLendingReadinessInput({ LENDING_POSITION_JSON: positionJson }).position);
    const output = formatLendingReadiness(report);

    expect(output).toContain("[lending] read-only health readiness");
    expect(output).toContain("execution: disabled");
    expect(output).toContain("healthFactorBps");
  });

  it("runs readiness and writes a JSONL trace event", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lending-readiness-"));
    const trace = createJsonlTraceWriter({ path: path.join(dir, "events.jsonl") });
    const writes: string[] = [];

    const report = await runLendingReadiness(
      { LENDING_POSITION_JSON: positionJson },
      (message) => writes.push(message),
      trace,
    );

    const [event] = (await readFile(trace.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(report.executionEnabled).toBe(false);
    expect(writes[0]).toContain("read-only health readiness");
    expect(event.type).toBe("lending.readiness");
    expect(event.report.protocolId).toBe("lendle");
    expect(event.report.executionEnabled).toBe(false);
  });
});
