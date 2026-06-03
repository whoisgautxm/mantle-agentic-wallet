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

const richState: VaultState = {
  ...state,
  balanceWei: 10n * 10n ** 18n,
  spendLimitPerTx: 10n * 10n ** 18n,
  dailyLimit: 10n * 10n ** 18n,
  spentToday: 0n,
  tokenBalanceWei: 1n * 10n ** 18n,
  priceWei: 2n * 10n ** 18n,
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

  it("blocks DEX quotes that deviate too far from the reference oracle", () => {
    const result = evaluateRisk({
      decision: buy,
      state,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle,
      quotePriceWei: 2_800n,
      simulation: { ok: true },
      limits: {
        maxDexOracleDeviationBps: 300n,
        maxPositionBps: 10_000n,
        maxTradeValueBps: 10_000n,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("DEX_ORACLE_DEVIATION");
  });

  it("blocks projected token exposure above the configured position limit", () => {
    const result = evaluateRisk({
      decision: {
        ...buy,
        valueWei: 8n * 10n ** 18n,
      },
      state: richState,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle: { ...oracle, priceWei: richState.priceWei },
      quotePriceWei: richState.priceWei,
      simulation: { ok: true },
      limits: {
        maxDexOracleDeviationBps: 300n,
        maxPositionBps: 5_000n,
        maxTradeValueBps: 10_000n,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("MAX_POSITION_SIZE");
  });

  it("blocks single trades above the configured portfolio-value limit", () => {
    const result = evaluateRisk({
      decision: {
        ...buy,
        valueWei: 4n * 10n ** 18n,
      },
      state: richState,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle: { ...oracle, priceWei: richState.priceWei },
      quotePriceWei: richState.priceWei,
      simulation: { ok: true },
      limits: {
        maxDexOracleDeviationBps: 300n,
        maxPositionBps: 10_000n,
        maxTradeValueBps: 2_000n,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("MAX_TRADE_VALUE");
  });

  it("warns when projected exposure approaches the configured position limit", () => {
    const result = evaluateRisk({
      decision: {
        ...buy,
        valueWei: 3n * 10n ** 18n,
      },
      state: richState,
      allowedTargets: [target],
      allowedSelectors: [buySelector],
      oracle: { ...oracle, priceWei: richState.priceWei },
      quotePriceWei: richState.priceWei,
      simulation: { ok: true },
      limits: {
        maxDexOracleDeviationBps: 300n,
        maxPositionBps: 5_000n,
        maxTradeValueBps: 10_000n,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.map((w) => w.ruleId)).toContain("POSITION_SIZE_WARNING");
  });
});
