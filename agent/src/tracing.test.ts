import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createJsonlTraceWriter, jsonSafe } from "./tracing.js";

describe("JSONL tracing", () => {
  it("serializes bigint values safely", () => {
    expect(jsonSafe({ amount: 123n, nested: [5n] })).toEqual({ amount: "123", nested: ["5"] });
  });

  it("appends one JSON object per line", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trace-test-"));
    const tracePath = path.join(dir, "events.jsonl");
    const writer = createJsonlTraceWriter({ path: tracePath });

    await writer.append("test.event", { amount: 123n, ok: true });
    await writer.append("test.second", { error: new Error("boom") });

    const lines = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "test.event", amount: "123", ok: true });
    expect(lines[1]).toMatchObject({ type: "test.second", error: { name: "Error", message: "boom" } });
  });

  it("does not write when disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trace-disabled-"));
    const tracePath = path.join(dir, "events.jsonl");
    const writer = createJsonlTraceWriter({ path: tracePath, enabled: false });

    await writer.append("test.event", { amount: 123n });
    expect(writer.enabled).toBe(false);
  });
});
