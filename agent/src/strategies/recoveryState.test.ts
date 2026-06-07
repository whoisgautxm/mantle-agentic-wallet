import { describe, it, expect } from "vitest";
import { deriveRecoveryPhase } from "./recoveryState.js";

const P = (...xs: number[]) => xs.map((x) => BigInt(Math.round(x * 1e18)));

describe("deriveRecoveryPhase", () => {
  it("is neutral with too few observations", () => {
    expect(deriveRecoveryPhase(P(2.0, 1.9, 1.8)).phase).toBe("neutral");
  });

  it("is neutral when no meaningful drawdown occurred", () => {
    expect(deriveRecoveryPhase(P(2.0, 2.01, 1.99, 2.0)).phase).toBe("neutral");
  });

  it("is downtrend while the low is the latest observation", () => {
    expect(deriveRecoveryPhase(P(2.0, 1.9, 1.8, 1.7)).phase).toBe("downtrend");
  });

  it("is stabilizing after a drop with only a tiny bounce off the low", () => {
    const r = deriveRecoveryPhase(P(2.0, 1.8, 1.7, 1.701));
    expect(r.phase).toBe("stabilizing");
    expect(r.drawdownBps).toBeLessThanOrEqual(-300);
  });

  it("is recovery_probe after a meaningful drop and a real bounce off the low", () => {
    const r = deriveRecoveryPhase(P(2.0, 1.9, 1.8, 1.7, 1.85));
    expect(r.phase).toBe("recovery_probe");
    expect(r.bounceBps).toBeGreaterThanOrEqual(150);
    expect(r.lowWei).toBe(BigInt(Math.round(1.7 * 1e18)));
  });
});
