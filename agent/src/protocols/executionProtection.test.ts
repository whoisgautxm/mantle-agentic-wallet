import { describe, expect, it } from "vitest";
import { applySlippageBps, buildExecutionProtection, loadExecutionProtectionFromEnv } from "./executionProtection.js";

describe("execution protection", () => {
  it("applies slippage basis points to expected output", () => {
    expect(applySlippageBps(1000n, 100n)).toBe(990n);
    expect(applySlippageBps(1000n, 0n)).toBe(1000n);
    expect(applySlippageBps(1000n, 10_000n)).toBe(0n);
  });

  it("builds minOut and deadline metadata", () => {
    const protection = buildExecutionProtection(10_000n, { slippageBps: 250n, deadlineSeconds: 600n });
    expect(protection).toEqual({
      slippageBps: 250n,
      minOutWei: 9750n,
      deadlineSeconds: 600n,
    });
  });

  it("loads env config with safe defaults", () => {
    expect(loadExecutionProtectionFromEnv({}).slippageBps).toBe(100n);
    expect(
      loadExecutionProtectionFromEnv({
        EXECUTION_SLIPPAGE_BPS: "25",
        EXECUTION_DEADLINE_SECONDS: "1200",
      }),
    ).toEqual({
      slippageBps: 25n,
      deadlineSeconds: 1200n,
    });
  });

  it("rejects invalid slippage", () => {
    expect(() => applySlippageBps(1n, 10_001n)).toThrow(/slippageBps/);
    expect(() => loadExecutionProtectionFromEnv({ EXECUTION_SLIPPAGE_BPS: "10001" })).toThrow(/10000/);
  });
});
