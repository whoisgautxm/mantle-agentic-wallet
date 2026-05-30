import { describe, it, expect } from "vitest";
import { parseToolUse } from "./brain.js";

const SINK = "0x2222222222222222222222222222222222222222" as const;

describe("parseToolUse", () => {
  it("maps a high-level pay intent to a contract-faithful execute Decision", () => {
    const d = parseToolUse(
      { action: "pay", amountMnt: "0.001", memo: "demo", rationale: "yield is favorable" },
      SINK,
    );
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.target).toBe(SINK);
      expect(d.valueWei).toBe(1_000_000_000_000_000n);
      expect(d.calldata.startsWith("0x")).toBe(true);
      expect(d.rationale).toBe("yield is favorable");
    }
  });

  it("parses a hold proposal", () => {
    const d = parseToolUse({ action: "hold", rationale: "uncertain" }, SINK);
    expect(d.kind).toBe("hold");
    expect(d.rationale).toBe("uncertain");
  });

  it("throws on a pay proposal missing fields", () => {
    expect(() => parseToolUse({ action: "pay", rationale: "x" }, SINK)).toThrow();
  });
});
