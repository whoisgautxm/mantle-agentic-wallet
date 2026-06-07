// Deterministic price-sequence generators for a reproducible keeper (live-run report sections 14 & 15).
// The default keeper used Math.random(), so no two live runs faced the same market and results could
// not be compared. These pure helpers let the keeper replay either a fixed regime script or a
// seeded walk, so AI and DCA face an identical, reproducible price path across runs and seeds.

/// mulberry32 PRNG: deterministic [0,1) from an integer seed. Same seed -> same sequence.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Controlled 40-tick benchmark sequence (report section 15): warm-up -> downtrend -> recovery ->
/// rally -> range, then flat. Deterministic per tick index — exercises every regime the same way every run.
export function scriptedReturnBps(tickIndex: number): number {
  if (tickIndex < 8) return tickIndex % 2 === 0 ? 15 : -15; // flat / warm-up
  if (tickIndex < 16) return -120; // sustained downtrend
  if (tickIndex < 22) return 90; // stabilization / recovery
  if (tickIndex < 32) return 110; // sustained rally
  if (tickIndex < 40) return tickIndex % 2 === 0 ? 60 : -60; // range
  return 0; // hold flat after the scripted window
}

/// Seeded random-walk step (bps) — deterministic given (seed, tickIndex), reproducible across runs.
export function seededReturnBps(seed: number, tickIndex: number, maxStepBps: number): number {
  const rnd = mulberry32(seed ^ ((tickIndex + 1) * 0x9e3779b1))();
  return Math.round((rnd - 0.5) * 2 * maxStepBps);
}

export interface ApplyReturnParams {
  prevWei: bigint;
  returnBps: number;
  centerWei: bigint;
  minWei: bigint;
  maxWei: bigint;
  reversionPct: number; // pull toward center, 0-100
}

/// Apply a bps return to the previous price with mean reversion toward center, clamped to [min,max].
export function applyReturn({ prevWei, returnBps, centerWei, minWei, maxWei, reversionPct }: ApplyReturnParams): bigint {
  let next = prevWei + (prevWei * BigInt(Math.trunc(returnBps))) / 10_000n;
  next = next + ((centerWei - next) * BigInt(Math.trunc(reversionPct))) / 100n;
  if (next < minWei) next = minWei;
  if (next > maxWei) next = maxWei;
  return next;
}
