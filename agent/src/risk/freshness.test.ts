import { describe, it, expect } from "vitest";
import { checkSnapshotFreshness } from "./freshness.js";

describe("checkSnapshotFreshness", () => {
  it("passes when the head has not drifted beyond tolerance", () => {
    const r = checkSnapshotFreshness({ snapshotBlock: 100n, headBlock: 102n, maxDriftBlocks: 3n });
    expect(r.ok).toBe(true);
    expect(r.driftBlocks).toBe(2n);
  });

  it("blocks when the snapshot is too far behind head (oracle floor may have moved)", () => {
    const r = checkSnapshotFreshness({ snapshotBlock: 100n, headBlock: 110n, maxDriftBlocks: 3n });
    expect(r.ok).toBe(false);
    expect(r.driftBlocks).toBe(10n);
    expect(r.reason).toMatch(/behind head/);
  });

  it("treats a head at or behind the snapshot as zero drift", () => {
    const r = checkSnapshotFreshness({ snapshotBlock: 100n, headBlock: 100n, maxDriftBlocks: 0n });
    expect(r.ok).toBe(true);
    expect(r.driftBlocks).toBe(0n);
  });
});
