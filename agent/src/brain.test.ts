import { describe, it, expect } from "vitest";
import {
  buildCandidateFromStrategy,
  buildDecisionFromCandidateAssessment,
  buildDecisionFromToolUse,
  decide,
  normalizeTradeIntent,
  parseCandidateAssessment,
  parseToolUseIntent,
} from "./brain.js";
import { computeMarketFeatures } from "./marketFeatures.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import type { StrategyFunction } from "./strategies/ensemble.js";
import type { VaultState } from "./types.js";

const DEX = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;
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
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const intent = parseToolUseIntent({ action: "buy", amountMnt: "0.01", rationale: "price dipped" });
    const d = await buildDecisionFromToolUse({ action: "buy", amountMnt: "0.01", rationale: "price dipped" }, adapter);

    expect(intent.action).toBe("buy");
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.action).toBe("buy");
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(10_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.outAsset).toBe(TOKEN);
      expect(d.minOutWei).toBeGreaterThan(0n);
      expect(d.rationale).toBe("price dipped");
    }
  });

  it("maps a sell tool call to a zero-value execute Decision with token amount metadata", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const d = await buildDecisionFromToolUse({ action: "sell", amountToken: "0.5", rationale: "take profit" }, adapter);

    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.action).toBe("sell");
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(0n);
      expect(d.amountTokenWei).toBe(500_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.outAsset).toBe("0x0000000000000000000000000000000000000000");
      expect(d.minOutWei).toBeGreaterThan(0n);
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
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
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
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
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
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
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
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
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

  it("lets an ensemble prior veto a contradictory model trade", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const holdPrior: StrategyFunction = () => ({
      action: "hold",
      sizePercent: 0,
      expectedEdgeBps: 0,
      rationale: "ensemble veto",
    });
    const decision = await buildDecisionFromToolUse(
      {
        regime: "range",
        confidence: 90,
        action: "buy",
        sizePercent: 80,
        amountMnt: "0.08",
        amountToken: "0",
        expectedEdgeBps: 300,
        invalidationCondition: "range breaks",
        rationale: "model buy",
      },
      adapter,
      state,
      { estimatedExecutionCostBps: 50, strategyPrior: holdPrior, strategyBaselineBuyWei: 2n * 10n ** 16n },
      computeMarketFeatures([2n * 10n ** 18n, 19n * 10n ** 17n, 2n * 10n ** 18n, 19n * 10n ** 17n]),
      [2n * 10n ** 18n, 19n * 10n ** 17n, 2n * 10n ** 18n, 19n * 10n ** 17n],
    );

    expect(decision.kind).toBe("hold");
    expect(decision.rationale).toContain("ensemble prior");
  });

  it("caps an aligned model trade to the ensemble prior size", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const buyPrior: StrategyFunction = () => ({
      action: "buy",
      amountMntWei: 3n * 10n ** 16n,
      sizePercent: 30,
      expectedEdgeBps: 200,
      rationale: "ensemble trend cap",
    });
    const decision = await buildDecisionFromToolUse(
      {
        regime: "trend_up",
        confidence: 90,
        action: "buy",
        sizePercent: 80,
        amountMnt: "0.08",
        amountToken: "0",
        expectedEdgeBps: 300,
        invalidationCondition: "trend breaks",
        rationale: "model trend buy",
      },
      adapter,
      state,
      { estimatedExecutionCostBps: 50, strategyPrior: buyPrior, strategyBaselineBuyWei: 2n * 10n ** 16n },
      computeMarketFeatures([
        2n * 10n ** 18n,
        21n * 10n ** 17n,
        22n * 10n ** 17n,
        23n * 10n ** 17n,
      ]),
      [2n * 10n ** 18n, 21n * 10n ** 17n, 22n * 10n ** 17n, 23n * 10n ** 17n],
    );

    expect(decision.kind).toBe("execute");
    if (decision.kind === "execute") {
      expect(decision.valueWei).toBe(3n * 10n ** 16n);
      expect(decision.rationale).toContain("ensemble prior capped");
    }
  });

  it("rejects a zero-inventory position hallucination instead of letting a model veto suppress a candidate", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const zeroInventoryState = { ...state, tokenBalanceWei: 0n };
    const priceHistory = [
      2n * 10n ** 18n,
      21n * 10n ** 17n,
      22n * 10n ** 17n,
      23n * 10n ** 17n,
    ];
    const features = computeMarketFeatures(priceHistory);
    const buyPrior: StrategyFunction = () => ({
      action: "buy",
      amountMntWei: 5n * 10n ** 16n,
      sizePercent: 50,
      expectedEdgeBps: 350,
      rationale: "Ensemble followed a confirmed uptrend with available cash.",
    });
    const result = buildCandidateFromStrategy(
      zeroInventoryState,
      priceHistory,
      features,
      { estimatedExecutionCostBps: 50, strategyPrior: buyPrior },
      2_000n,
    );

    expect(result.candidate?.action).toBe("buy");
    const assessment = parseCandidateAssessment({
      candidateId: result.candidate?.id,
      verdict: "veto",
      vetoCode: "state_inconsistency",
      confidence: 80,
      evidence: ["Avoid repeatedly selling the winning position."],
      rationale: "Preserve the winning position instead of adding.",
    });
    const decision = await buildDecisionFromCandidateAssessment(
      result.candidate!,
      assessment,
      adapter,
      zeroInventoryState,
      result.analysis,
    );

    expect(decision.kind).toBe("execute");
    if (decision.kind === "execute") {
      expect(decision.action).toBe("buy");
      expect(decision.valueWei).toBe(5n * 10n ** 16n);
      expect(decision.rationale).toContain("OpenAI veto ignored");
      expect(decision.agentTrace?.assessmentValidation).toMatchObject({
        ok: false,
        finalVerdict: "invalid_veto_ignored",
      });
    }
  });

  it("holds before an OpenAI call when the deterministic candidate is uneconomic", () => {
    const priceHistory = [
      2n * 10n ** 18n,
      21n * 10n ** 17n,
      22n * 10n ** 17n,
      23n * 10n ** 17n,
    ];
    const features = computeMarketFeatures(priceHistory);
    const tinyBuyPrior: StrategyFunction = () => ({
      action: "buy",
      amountMntWei: 1n * 10n ** 16n,
      sizePercent: 10,
      expectedEdgeBps: 150,
      rationale: "Tiny uptrend buy candidate.",
    });
    const result = buildCandidateFromStrategy(
      { ...state, tokenBalanceWei: 0n },
      priceHistory,
      features,
      {
        estimatedExecutionCostBps: 50,
        strategyPrior: tinyBuyPrior,
        preModelGasEstimateUnits: 170_000n,
        preModelGasPriceWei: 50_000_100_000n,
        slippageBps: 100,
        costBufferBps: 10,
      },
      2_000n,
    );

    expect(result.candidate).toBeUndefined();
    expect(result.hold?.kind).toBe("hold");
    expect(result.reason).toBe("economic_pre_gate_hold");
    expect(result.economicGate?.ok).toBe(false);
    expect(result.hold?.rationale).toContain("held before model call");
  });

  it("honors a valid model veto for a deterministic candidate", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const priceHistory = [
      2n * 10n ** 18n,
      21n * 10n ** 17n,
      22n * 10n ** 17n,
      23n * 10n ** 17n,
    ];
    const features = computeMarketFeatures(priceHistory);
    const buyPrior: StrategyFunction = () => ({
      action: "buy",
      amountMntWei: 5n * 10n ** 16n,
      sizePercent: 50,
      expectedEdgeBps: 350,
      rationale: "Ensemble followed a confirmed uptrend with available cash.",
    });
    const result = buildCandidateFromStrategy(
      { ...state, tokenBalanceWei: 0n },
      priceHistory,
      features,
      { estimatedExecutionCostBps: 50, strategyPrior: buyPrior },
      2_000n,
    );
    const assessment = parseCandidateAssessment({
      candidateId: result.candidate?.id,
      verdict: "veto",
      vetoCode: "tail_risk",
      confidence: 76,
      evidence: ["Recent momentum is positive but tail-risk evidence is still elevated."],
      rationale: "Tail risk is too high for this controlled example.",
    });
    const decision = await buildDecisionFromCandidateAssessment(
      result.candidate!,
      assessment,
      adapter,
      { ...state, tokenBalanceWei: 0n },
      result.analysis,
    );

    expect(decision.kind).toBe("hold");
    expect(decision.rationale).toContain("OpenAI vetoed deterministic candidate");
    expect(decision.agentTrace?.assessmentValidation).toMatchObject({
      ok: true,
      finalVerdict: "vetoed",
    });
  });

  it("uses OpenAI as a candidate critic in ensemble mode instead of asking for a free-form action", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const priceHistory = [
      2n * 10n ** 18n,
      21n * 10n ** 17n,
      22n * 10n ** 17n,
      23n * 10n ** 17n,
    ];
    const buyPrior: StrategyFunction = () => ({
      action: "buy",
      amountMntWei: 5n * 10n ** 16n,
      sizePercent: 50,
      expectedEdgeBps: 350,
      rationale: "Ensemble followed a confirmed uptrend with available cash.",
    });
    const calls: any[] = [];
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async (payload: any) => {
            calls.push(payload);
            const userContent = String(payload.input[1].content);
            const candidate = JSON.parse(userContent.match(/Candidate JSON: (.+)\n\nReturn/)?.[1] ?? "{}");
            return {
              output: [
                {
                  type: "function_call",
                  name: "assess_trade_candidate",
                  arguments: JSON.stringify({
                    candidateId: candidate.id,
                    verdict: "approve",
                    vetoCode: "none",
                    confidence: 82,
                    evidence: ["Candidate is grounded in the supplied trend and zero token inventory."],
                    rationale: "Approve the deterministic candidate.",
                  }),
                },
              ],
            };
          },
        },
      },
    };

    const decision = await decide(
      client as any,
      { ...state, tokenBalanceWei: 0n },
      priceHistory,
      adapter,
      "Assess the supplied candidate.",
      { estimatedExecutionCostBps: 50, strategyPrior: buyPrior },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].tools[0].name).toBe("assess_trade_candidate");
    expect(decision.kind).toBe("execute");
    expect(decision.agentTrace?.decisionMode).toBe("candidate_assessment");
  });

  it("does not spend an OpenAI call when the deterministic strategy already holds", async () => {
    const adapter = createMockDexAdapter(DEX, TOKEN, async () => 2n * 10n ** 18n);
    const holdPrior: StrategyFunction = () => ({
      action: "hold",
      sizePercent: 0,
      expectedEdgeBps: 0,
      rationale: "No feasible deterministic candidate.",
    });
    const client = {
      provider: "openai" as const,
      openai: {
        responses: {
          create: async () => {
            throw new Error("OpenAI should not be called for deterministic holds");
          },
        },
      },
    };

    const decision = await decide(
      client as any,
      { ...state, tokenBalanceWei: 0n },
      [2n * 10n ** 18n, 21n * 10n ** 17n],
      adapter,
      "Assess the supplied candidate.",
      { estimatedExecutionCostBps: 50, strategyPrior: holdPrior },
    );

    expect(decision.kind).toBe("hold");
    expect(decision.rationale).toContain("No feasible deterministic candidate");
    expect(decision.agentTrace?.candidateGate).toMatchObject({ reason: "strategy_hold" });
  });
});
