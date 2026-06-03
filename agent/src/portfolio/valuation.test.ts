import { describe, expect, it } from "vitest";
import { exposureBps, tokenValueWei } from "./valuation.js";

describe("portfolio valuation", () => {
  it("values tokens with arbitrary decimals into wei", () => {
    expect(tokenValueWei(1_000_000n, 2n * 10n ** 18n, 6)).toBe(2n * 10n ** 18n);
    expect(tokenValueWei(5n * 10n ** 17n, 3n * 10n ** 18n, 18)).toBe(15n * 10n ** 17n);
  });

  it("computes exposure in basis points", () => {
    expect(exposureBps(2n * 10n ** 18n, 10n * 10n ** 18n)).toBe(2_000n);
  });
});
