import { describe, expect, it } from "vitest";
import { formatAlert } from "./telegram.js";

describe("formatAlert", () => {
  it("formats a buy alert", () => {
    const alert = formatAlert({
      kind: "execute",
      action: "buy",
      target: "0x1111111111111111111111111111111111111111",
      valueWei: 10_000_000_000_000_000n,
      calldata: "0x",
      rationale: "price dipped",
    });

    expect(alert).toContain("BUY 0.01 MNT");
    expect(alert).toContain("price dipped");
  });

  it("formats a sell alert", () => {
    const alert = formatAlert({
      kind: "execute",
      action: "sell",
      target: "0x1111111111111111111111111111111111111111",
      valueWei: 0n,
      amountTokenWei: 1n,
      calldata: "0x",
      rationale: "taking profit",
    });

    expect(alert).toContain("SELL");
    expect(alert).toContain("taking profit");
  });

  it("formats a hold alert", () => {
    expect(formatAlert({ kind: "hold", rationale: "waiting" })).toContain("HOLD");
  });
});
