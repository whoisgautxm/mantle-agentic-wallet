import { describe, it, expect } from "vitest";
import { parseToolUse } from "./brain.js";

const DEX = "0x3333333333333333333333333333333333333333" as const;

describe("parseToolUse", () => {
  it("maps a buy intent to a contract-faithful execute Decision", () => {
    const d = parseToolUse({ action: "buy", amountMnt: "0.01", rationale: "price dipped" }, DEX);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.action).toBe("buy");
      expect(d.target).toBe(DEX);
      expect(d.valueWei).toBe(10_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.rationale).toBe("price dipped");
    }
  });

  it("maps a sell intent to a zero-value execute Decision with token amount metadata", () => {
    const d = parseToolUse({ action: "sell", amountToken: "0.5", rationale: "take profit" }, DEX);
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
    const d = parseToolUse({ action: "hold", rationale: "uncertain" }, DEX);
    expect(d.kind).toBe("hold");
    expect(d.rationale).toBe("uncertain");
  });

  it("throws on missing trade amount", () => {
    expect(() => parseToolUse({ action: "buy", rationale: "x" }, DEX)).toThrow(/amountMnt/);
    expect(() => parseToolUse({ action: "sell", rationale: "x" }, DEX)).toThrow(/amountToken/);
  });

  it("throws on zero or negative trade amounts", () => {
    expect(() => parseToolUse({ action: "buy", amountMnt: "0", rationale: "x" }, DEX)).toThrow(/positive/);
    expect(() => parseToolUse({ action: "sell", amountToken: "-0.1", rationale: "x" }, DEX)).toThrow(/positive/);
  });
});
