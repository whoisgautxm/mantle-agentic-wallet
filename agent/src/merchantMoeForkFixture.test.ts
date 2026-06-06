import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { runMerchantMoeForkFixture } from "./merchantMoeForkFixture.js";
import { createJsonlTraceWriter } from "./tracing.js";

describe("Merchant Moe controlled fork fixture", () => {
  it("passes the full upstream gate without enabling live execution", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "merchant-moe-fork-fixture-"));
    const trace = createJsonlTraceWriter({ path: path.join(dir, "events.jsonl") });
    const writes: string[] = [];

    const report = await runMerchantMoeForkFixture((message) => writes.push(message), trace);
    const [event] = (await readFile(trace.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(report.ok).toBe(true);
    expect(report.fixtureMode).toBe(true);
    expect(report.fixtureKind).toBe("deterministic");
    expect(report.executionEnabled).toBe(false);
    expect(report.calldataSource).toBe("auto");
    expect(report.preflight?.status).toBe("ok");
    expect(report.preflight?.balanceOk).toBe(true);
    expect(report.preflight?.allowanceOk).toBe(true);
    expect(report.simulationAttempted).toBe(true);
    expect(report.simulationPassed).toBe(true);
    expect(report.simulation?.gasEstimate).toBe(184_000n);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(["LIVE_EXECUTION_DISABLED"]);
    expect(writes[0]).toContain("fixtureMode: true");
    expect(event.type).toBe("merchant_moe.fork_simulation");
    expect(event.fixtureMode).toBe(true);
    expect(event.report.ok).toBe(true);
  });
});
