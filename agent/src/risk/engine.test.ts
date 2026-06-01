import { describe, expect, it } from "vitest";
import { encodeBuy, encodeSell } from "../dex.js";
import type { PriceSnapshot } from "../oracles/types.js";
import { evaluateRisk } from "./engine.js";
import type { Decision, VaultState } from "../types.js";

const state: VaultState = {
  balanceWei: 1_000n,
  spendLimitPerTx: 100n,
  dailyLimit: 200n,
  spentToday: 0n,
  windowStart: 1_000n,
  paused: false,
  tokenBalanceWei: 500n,
  priceWei: 2_000n,
};

const target = "0x1111111111111111111111111111111111111111" as const;
const buySelector = encodeBuy().slice(0, 10) as `0x${string}`;
const sellSelector = encodeSell(1n).slice(0, 10) as `0x${string}`;

const oracle: PriceSnapshot = {
  pair: "MNT/MOCK",
  priceWei: 2_000n,
  source: "mockdex",
  updatedAt: 1_000n,
  stale: false,
  maxAgeSeconds: 300n,
};

const buy: Decision = {
  kind: "execute",
  action: "buy",
  target,
  valueWei: 50n,
  calldata: encodeBuy(),
  rationale: "test buy",
};

describe("evaluateRisk", () => {
  it("allows a safe simulated adapter execution", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: [target],
      allowedSelectors: [buySelector, sellSelector],
      oracle,
      simulation: { ok: true },
    });
    expect(result.ok).toBe(true);
  });

  it("blocks targets outside the adapter allowlist", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: ["0x2222222222222222222222222222222222222222"],
      allowedSelectors: [buySelector],
      oracle,
      simulation: { ok: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("TARGET_NOT_ALLOWED");
  });

  it("blocks selectors outside the adapter allowlist", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: [target],
      allowedSelectors: [sellSelector],
      oracle,
      simulation: { ok: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("FUNCTION_NOT_ALLOWED");
  });

  it("blocks stale oracle snapshots", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle: { ...oracle, stale: true },
      simulation: { ok: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("ORACLE_STALE");
  });

  it("blocks failed simulations", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle,
      simulation: { ok: false, reason: "paused" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.ruleId).toBe("SIMULATION_FAILED");
      expect(result.reason).toBe("paused");
    }
  });
});
