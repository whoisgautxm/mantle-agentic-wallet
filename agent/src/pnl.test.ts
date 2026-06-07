import { describe, expect, it } from "vitest";
import { portfolioSnapshot, portfolioValueWei, roiBps } from "./pnl.js";

describe("portfolioValueWei", () => {
  it("adds MNT balance and token value", () => {
    expect(portfolioValueWei(1n * 10n ** 18n, 5n * 10n ** 17n, 2n * 10n ** 18n)).toBe(2n * 10n ** 18n);
  });

  it("returns just MNT balance when no tokens are held", () => {
    expect(portfolioValueWei(3n * 10n ** 18n, 0n, 2n * 10n ** 18n)).toBe(3n * 10n ** 18n);
  });
});

describe("roiBps", () => {
  it("computes gains in basis points", () => {
    expect(roiBps(11n * 10n ** 17n, 1n * 10n ** 18n)).toBe(1000n);
  });

  it("computes losses in basis points", () => {
    expect(roiBps(85n * 10n ** 16n, 1n * 10n ** 18n)).toBe(-1500n);
  });

  it("returns zero when the reference value is zero", () => {
    expect(roiBps(100n, 0n)).toBe(0n);
  });
});

describe("portfolioSnapshot", () => {
  it("records balances, token value, and replay-window ROI", () => {
    const snapshot = portfolioSnapshot(
      {
        balanceWei: 8n * 10n ** 17n,
        tokenBalanceWei: 1n * 10n ** 17n,
        priceWei: 2n * 10n ** 18n,
        spendLimitPerTx: 1n,
        dailyLimit: 1n,
        spentToday: 0n,
        windowStart: 0n,
        paused: false,
      },
      9n * 10n ** 17n,
    );

    expect(snapshot.tokenValueWei).toBe(2n * 10n ** 17n);
    expect(snapshot.portfolioValueWei).toBe(1n * 10n ** 18n);
    expect(snapshot.roiBps).toBe(1111n);
  });
});
