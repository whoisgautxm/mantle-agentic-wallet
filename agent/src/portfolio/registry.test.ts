import { describe, expect, it } from "vitest";
import { parseSpenderRegistry, parseTokenRegistry } from "./registry.js";

describe("portfolio registry parsers", () => {
  it("parses token entries", () => {
    const tokens = parseTokenRegistry(
      "USDC:0x1111111111111111111111111111111111111111:6:stable:USDC/USD,WETH:0x2222222222222222222222222222222222222222:18:core:ETH/USD",
    );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ symbol: "USDC", decimals: 6, riskTier: "stable", pricePair: "USDC/USD" });
    expect(tokens[1]).toMatchObject({ symbol: "WETH", decimals: 18, riskTier: "core" });
  });

  it("parses spender entries", () => {
    const spenders = parseSpenderRegistry(
      "MerchantMoe:0x3333333333333333333333333333333333333333:known,Permit2:0x4444444444444444444444444444444444444444:trusted",
    );
    expect(spenders).toHaveLength(2);
    expect(spenders[0]).toMatchObject({ name: "MerchantMoe", riskTier: "known" });
    expect(spenders[1]).toMatchObject({ name: "Permit2", riskTier: "trusted" });
  });

  it("rejects malformed token addresses", () => {
    expect(() => parseTokenRegistry("BAD:0x123:18")).toThrow(/address/);
  });
});
