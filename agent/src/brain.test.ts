import { describe, it, expect } from "vitest";
import { buildDecisionFromToolUse, parseToolUseIntent } from "./brain.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";

const DEX = "0x3333333333333333333333333333333333333333" as const;

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
});
