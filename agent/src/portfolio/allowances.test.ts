import { describe, expect, it } from "vitest";
import { MAX_UINT256, buildAllowanceInfo, classifyAllowance, isUnsafeAllowance } from "./allowances.js";
import type { SpenderInfo, TokenInfo } from "./types.js";

const token: TokenInfo = {
  chainId: 5003,
  address: "0x1111111111111111111111111111111111111111",
  symbol: "USDC",
  decimals: 6,
  riskTier: "stable",
};

const spender: SpenderInfo = {
  name: "Router",
  address: "0x2222222222222222222222222222222222222222",
  riskTier: "known",
};

describe("allowance classification", () => {
  it("classifies empty, bounded, excessive, and unbounded approvals", () => {
    expect(classifyAllowance(0n, 100n)).toBe("none");
    expect(classifyAllowance(200n, 100n)).toBe("bounded");
    expect(classifyAllowance(600n, 100n)).toBe("excessive");
    expect(classifyAllowance(MAX_UINT256, 100n)).toBe("unbounded");
  });

  it("marks excessive and unbounded approvals as unsafe", () => {
    expect(isUnsafeAllowance("none")).toBe(false);
    expect(isUnsafeAllowance("bounded")).toBe(false);
    expect(isUnsafeAllowance("excessive")).toBe(true);
    expect(isUnsafeAllowance("unbounded")).toBe(true);
  });

  it("builds a report row with unsafe status", () => {
    const info = buildAllowanceInfo({
      token,
      spender,
      owner: "0x3333333333333333333333333333333333333333",
      allowanceRaw: MAX_UINT256,
      expectedSpendRaw: 100n,
    });
    expect(info.status).toBe("unbounded");
    expect(info.unsafe).toBe(true);
  });
});
