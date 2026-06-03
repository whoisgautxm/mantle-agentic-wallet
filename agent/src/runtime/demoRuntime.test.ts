import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  cleanStaleProcessRecords,
  formatAge,
  isPidRunning,
  readAllProcessRecords,
  readProcessRecord,
  writeProcessRecord,
  type DemoProcessRecord,
} from "./demoRuntime.js";

function record(pid: number): DemoProcessRecord {
  return {
    component: "agent",
    pid,
    command: ["npm", "start"],
    cwd: "/tmp/agent",
    startedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("demo runtime", () => {
  it("writes and reads process records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demo-runtime-"));
    await writeProcessRecord(root, record(process.pid));

    const written = await readProcessRecord(root, "agent");
    expect(written?.pid).toBe(process.pid);
    expect(written?.command).toEqual(["npm", "start"]);
  });

  it("detects the current process as running", () => {
    expect(isPidRunning(process.pid)).toBe(true);
    expect(isPidRunning(-1)).toBe(false);
  });

  it("cleans stale process records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demo-runtime-"));
    await writeProcessRecord(root, record(9_999_999));

    const active = await cleanStaleProcessRecords(root);
    const records = await readAllProcessRecords(root);

    expect(active).toEqual([]);
    expect(records).toEqual([]);
  });

  it("formats record ages", () => {
    expect(formatAge("2026-06-03T00:00:00.000Z", Date.parse("2026-06-03T00:00:42.000Z"))).toBe("42s");
    expect(formatAge("2026-06-03T00:00:00.000Z", Date.parse("2026-06-03T00:12:00.000Z"))).toBe("12m");
    expect(formatAge("2026-06-03T00:00:00.000Z", Date.parse("2026-06-03T02:05:00.000Z"))).toBe("2h 5m");
  });
});
