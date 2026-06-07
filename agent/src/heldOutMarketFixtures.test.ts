import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { generateHeldOutFixtureSet, writeHeldOutFixtureSet } from "./heldOutMarketFixtures.js";

describe("held-out market fixtures", () => {
  it("generates deterministic and disjoint development/test paths", () => {
    const options = { seed: 42, devPaths: 4, testPaths: 8, ticks: 10 };
    const first = generateHeldOutFixtureSet(options);
    const second = generateHeldOutFixtureSet(options);

    expect(first).toEqual(second);
    expect(first.development.regimes).toHaveLength(4);
    expect(first.heldOut.regimes).toHaveLength(8);
    expect(first.development.regimes[0].prices).toHaveLength(10);
    expect(new Set(first.development.regimes.map((regime) => regime.id))).not.toContain(
      first.heldOut.regimes[0].id,
    );
  });

  it("writes both fixture splits as replayable JSON", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "held-out-markets-"));
    const paths = await writeHeldOutFixtureSet(
      generateHeldOutFixtureSet({ seed: 7, devPaths: 2, testPaths: 3, ticks: 8 }),
      output,
    );
    const heldOut = JSON.parse(await readFile(paths.heldOutPath, "utf8"));

    expect(heldOut.version).toBe(1);
    expect(heldOut.regimes).toHaveLength(3);
  });
});
