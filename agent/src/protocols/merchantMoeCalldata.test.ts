import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { LB_ROUTER_SWAP_ABI, buildMerchantMoeSwapExactTokensForTokensCalldata } from "./merchantMoeCalldata.js";

const tokenA = "0x1111111111111111111111111111111111111111" as const;
const tokenB = "0x2222222222222222222222222222222222222222" as const;
const recipient = "0x3333333333333333333333333333333333333333" as const;

describe("Merchant Moe calldata builder", () => {
  it("encodes swapExactTokensForTokens with quote path metadata", () => {
    const calldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: 1000n,
      amountOutMin: 990n,
      tokenPath: [tokenA, tokenB],
      pairBinSteps: [25n],
      versions: [3],
      recipient,
      deadline: 1_800_000_000n,
    });

    const decoded = decodeFunctionData({ abi: LB_ROUTER_SWAP_ABI, data: calldata });
    expect(calldata.slice(0, 2)).toBe("0x");
    expect(decoded.functionName).toBe("swapExactTokensForTokens");
    expect(decoded.args[0]).toBe(1000n);
    expect(decoded.args[1]).toBe(990n);
    expect(decoded.args[2]).toEqual({
      pairBinSteps: [25n],
      versions: [3],
      tokenPath: [tokenA, tokenB],
    });
    expect(decoded.args[3]).toBe(recipient);
    expect(decoded.args[4]).toBe(1_800_000_000n);
  });

  it("rejects path metadata that does not match token hops", () => {
    expect(() =>
      buildMerchantMoeSwapExactTokensForTokensCalldata({
        amountIn: 1000n,
        amountOutMin: 990n,
        tokenPath: [tokenA, tokenB],
        pairBinSteps: [],
        versions: [3],
        recipient,
        deadline: 1_800_000_000n,
      }),
    ).toThrow(/pairBinSteps length/);
  });

  it("requires positive input, min output, and deadline", () => {
    expect(() =>
      buildMerchantMoeSwapExactTokensForTokensCalldata({
        amountIn: 0n,
        amountOutMin: 990n,
        tokenPath: [tokenA, tokenB],
        pairBinSteps: [25n],
        versions: [3],
        recipient,
        deadline: 1_800_000_000n,
      }),
    ).toThrow(/amountIn must be positive/);
  });
});
