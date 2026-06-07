import { describe, expect, it } from "vitest";
import { createMockDexAdapter } from "./mockDexAdapter.js";
import { planToDecision } from "./types.js";

const dex = "0x3333333333333333333333333333333333333333" as const;
const token = "0x4444444444444444444444444444444444444444" as const;

describe("createMockDexAdapter", () => {
  it("builds a buy execution plan with quote metadata", async () => {
    const adapter = createMockDexAdapter(dex, token, async () => 2n * 10n ** 18n, {
      slippageBps: 100n,
      deadlineSeconds: 600n,
    });
    const quote = await adapter.quote({
      action: "buy",
      amountMntWei: 10n ** 18n,
      rationale: "buy one MNT worth",
    });
    const plan = adapter.buildPlan(
      { action: "buy", amountMntWei: 10n ** 18n, rationale: "buy one MNT worth" },
      quote,
    );

    expect(plan.protocolId).toBe("mockdex");
    expect(plan.target).toBe(dex);
    expect(plan.valueWei).toBe(10n ** 18n);
    expect(plan.expectedOutWei).toBe(5n * 10n ** 17n);
    expect(plan.minOutWei).toBe(495n * 10n ** 15n);
    expect(plan.outputAsset).toBe(token);
    expect(plan.slippageBps).toBe(100n);
    expect(plan.deadlineSeconds).toBe(600n);
    expect(adapter.allowedSelectors).toContain(plan.calldata.slice(0, 10));
  });

  it("builds a sell execution plan and converts it to a Decision", async () => {
    const adapter = createMockDexAdapter(dex, token, async () => 2n * 10n ** 18n, { slippageBps: 250n });
    const intent = {
      action: "sell" as const,
      amountTokenWei: 5n * 10n ** 17n,
      rationale: "take profit",
    };
    const quote = await adapter.quote(intent);
    const plan = adapter.buildPlan(intent, quote);
    const decision = planToDecision(plan, intent.rationale);

    expect(plan.valueWei).toBe(0n);
    expect(plan.expectedOutWei).toBe(10n ** 18n);
    expect(plan.minOutWei).toBe(975n * 10n ** 15n);
    expect(plan.outputAsset).toBe("0x0000000000000000000000000000000000000000");
    expect(decision.kind).toBe("execute");
    if (decision.kind === "execute") {
      expect(decision.action).toBe("sell");
      expect(decision.amountTokenWei).toBe(intent.amountTokenWei);
      expect(decision.outAsset).toBe("0x0000000000000000000000000000000000000000");
      expect(decision.minOutWei).toBe(975n * 10n ** 15n);
    }
  });
});
