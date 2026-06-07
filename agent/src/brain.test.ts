import { describe, it, expect } from "vitest";
import { buildDecisionFromToolUse, normalizeTradeIntent, parseToolUseIntent } from "./brain.js";
import { computeMarketFeatures } from "./marketFeatures.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import type { VaultState } from "./types.js";

const DEX = "0x3333333333333333333333333333333333333333" as const;
const state: VaultState = {
  balanceWei: 1n * 10n ** 18n,
  spendLimitPerTx: 1n * 10n ** 17n,
  dailyLimit: 5n * 10n ** 18n,
  spentToday: 0n,
  windowStart: 1_000n,
  paused: false,
  tokenBalanceWei: 5n * 10n ** 17n,
  priceWei: 2n * 10n ** 18n,
};

describe("tool-use parsing", () => {
  it("maps a buy tool call to intent, then lets the adapter build the execute Decision", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const intent = parseToolUseIntent({ action: "buy", amountMnt: "0.01", rationale: "price dipped" });
    const d = await buildDecisionFromToolUse({ action: "buy", amountMnt: "0.01", rationale: "price dipped" }, adapter);

    expect(intent.action).toBe("buy");
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.action).toBe("buy");
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(10_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.rationale).toBe("price dipped");
    }
  });

  it("maps a sell tool call to a zero-value execute Decision with token amount metadata", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const d = await buildDecisionFromToolUse({ action: "sell", amountToken: "0.5", rationale: "take profit" }, adapter);

    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.action).toBe("sell");
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(0n);
      expect(d.amountTokenWei).toBe(500_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
    }
  });

  it("parses a hold proposal", () => {
    const d = parseToolUseIntent({ action: "hold", rationale: "uncertain" });
    expect(d.action).toBe("hold");
    expect(d.rationale).toBe("uncertain");
  });

  it("throws on missing trade amount", () => {
    expect(() => parseToolUseIntent({ action: "buy", rationale: "x" })).toThrow(/amountMnt/);
    expect(() => parseToolUseIntent({ action: "sell", rationale: "x" })).toThrow(/amountToken/);
  });

  it("throws on zero or negative trade amounts", () => {
    expect(() => parseToolUseIntent({ action: "buy", amountMnt: "0", rationale: "x" })).toThrow(/positive/);
    expect(() => parseToolUseIntent({ action: "sell", amountToken: "-0.1", rationale: "x" })).toThrow(/positive/);
  });

  it("caps human-unit sell proposals to 60% of available token inventory", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const decision = await buildDecisionFromToolUse(
      { action: "sell", amountToken: "500000000000000000", rationale: "take profit" },
      adapter,
      state,
    );

    expect(decision.kind).toBe("execute");
    if (decision.kind === "execute") {
      expect(decision.amountTokenWei).toBe(3n * 10n ** 17n);
      expect(decision.rationale).toContain("sell capped");
    }
  });

  it("turns sells into holds when inventory is zero", () => {
    const normalized = normalizeTradeIntent(
      { action: "sell", amountTokenWei: 1n, rationale: "sell" },
      { ...state, tokenBalanceWei: 0n },
      2_000n,
    );

    expect(normalized.action).toBe("hold");
    expect(normalized.rationale).toContain("inventory is zero");
  });

  it("caps buys to the tightest balance, transaction, or daily limit", () => {
    const normalized = normalizeTradeIntent(
      { action: "buy", amountMntWei: 1n * 10n ** 18n, rationale: "buy dip" },
      { ...state, dailyLimit: 15n * 10n ** 16n, spentToday: 10n * 10n ** 16n },
      1_500n,
    );

    expect(normalized.action).toBe("buy");
    if (normalized.action === "buy") expect(normalized.amountMntWei).toBe(5n * 10n ** 16n);
  });

  it("changes low-confidence model trades to holds before quoting", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const decision = await buildDecisionFromToolUse(
      {
        regime: "range",
        confidence: 40,
        action: "buy",
        sizePercent: 30,
        amountMnt: "0.03",
        amountToken: "0",
        expectedEdgeBps: 200,
        invalidationCondition: "range breaks",
        rationale: "buy the range low",
      },
      adapter,
      state,
      { estimatedExecutionCostBps: 50 },
      computeMarketFeatures([2n * 10n ** 18n, 19n * 10n ** 17n, 2n * 10n ** 18n, 19n * 10n ** 17n]),
    );

    expect(decision.kind).toBe("hold");
    expect(decision.rationale).toContain("confidence 40 is below 55");
    expect(decision.analysis?.expectedEdgeBps).toBe(200);
  });

  it("requires expected edge to exceed estimated execution costs", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const decision = await buildDecisionFromToolUse(
      {
        regime: "range",
        confidence: 80,
        action: "buy",
        sizePercent: 30,
        amountMnt: "0.03",
        amountToken: "0",
        expectedEdgeBps: 55,
        invalidationCondition: "range breaks",
        rationale: "small edge",
      },
      adapter,
      state,
      { estimatedExecutionCostBps: 50, edgeBufferBps: 10 },
    );

    expect(decision.kind).toBe("hold");
    expect(decision.rationale).toContain("60 bps cost threshold");
  });

  it("caps dip buying to 15% of capacity during a deterministic downtrend", async () => {
    const adapter = createMockDexAdapter(DEX, async () => 2n * 10n ** 18n);
    const features = computeMarketFeatures([
      24n * 10n ** 17n,
      22n * 10n ** 17n,
      20n * 10n ** 17n,
      18n * 10n ** 17n,
    ]);
    const decision = await buildDecisionFromToolUse(
      {
        regime: "trend_down",
        confidence: 90,
        action: "buy",
        sizePercent: 80,
        amountMnt: "0.08",
        amountToken: "0",
        expectedEdgeBps: 300,
        invalidationCondition: "new low",
        rationale: "attempt dip buy",
      },
      adapter,
      state,
      { estimatedExecutionCostBps: 50 },
      features,
    );

    expect(features.regime).toBe("trend_down");
    expect(decision.kind).toBe("execute");
    if (decision.kind === "execute") {
      expect(decision.valueWei).toBe(15n * 10n ** 15n);
      expect(decision.rationale).toContain("15% of available capacity");
      expect(decision.analysis?.marketFeatures?.regime).toBe("trend_down");
    }
  });
});
