import { describe, it, expect } from "vitest";
import { mulberry32, scriptedReturnBps, seededReturnBps, applyReturn } from "./priceSequence.js";

const ONE = 10n ** 18n;

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("scriptedReturnBps", () => {
  it("walks warm-up -> downtrend -> recovery -> rally -> range -> flat", () => {
    expect(Math.abs(scriptedReturnBps(0))).toBeLessThanOrEqual(20); // warm-up
    expect(scriptedReturnBps(10)).toBeLessThan(0); // downtrend
    expect(scriptedReturnBps(18)).toBeGreaterThan(0); // recovery
    expect(scriptedReturnBps(26)).toBeGreaterThan(0); // rally
    expect(Math.abs(scriptedReturnBps(36))).toBe(60); // range
    expect(scriptedReturnBps(50)).toBe(0); // flat after script
  });
});

describe("seededReturnBps", () => {
  it("is reproducible per (seed, tick) and bounded", () => {
    expect(seededReturnBps(7, 3, 600)).toBe(seededReturnBps(7, 3, 600));
    const step = seededReturnBps(7, 3, 600);
    expect(Math.abs(step)).toBeLessThanOrEqual(600);
  });
});

describe("applyReturn", () => {
  it("returns the previous price when return and reversion are zero", () => {
    expect(
      applyReturn({ prevWei: 2n * ONE, returnBps: 0, centerWei: 2n * ONE, minWei: ONE / 2n, maxWei: 6n * ONE, reversionPct: 0 }),
    ).toBe(2n * ONE);
  });
  it("applies a positive return with mean reversion toward center", () => {
    // +10% -> 2.2, reversion 10% toward 2.0 -> 2.2 + (2.0-2.2)*0.1 = 2.18
    expect(
      applyReturn({ prevWei: 2n * ONE, returnBps: 1000, centerWei: 2n * ONE, minWei: ONE / 2n, maxWei: 6n * ONE, reversionPct: 10 }),
    ).toBe(2_180_000_000_000_000_000n);
  });
  it("clamps to the ceiling", () => {
    expect(
      applyReturn({ prevWei: 5_900_000_000_000_000_000n, returnBps: 1000, centerWei: 2n * ONE, minWei: ONE / 2n, maxWei: 6n * ONE, reversionPct: 0 }),
    ).toBe(6n * ONE);
  });
  it("clamps to the floor on a large drop", () => {
    expect(
      applyReturn({ prevWei: 6n * ONE / 10n, returnBps: -5000, centerWei: 2n * ONE, minWei: ONE / 2n, maxWei: 6n * ONE, reversionPct: 0 }),
    ).toBe(ONE / 2n);
  });
});
