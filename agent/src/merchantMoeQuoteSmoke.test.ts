import { describe, expect, it } from "vitest";
import {
  formatMerchantMoeQuote,
  parseMerchantMoeQuoteSmokeConfig,
  runMerchantMoeQuoteSmoke,
} from "./merchantMoeQuoteSmoke.js";
import type { MerchantMoeQuote } from "./protocols/merchantMoeReadOnlyAdapter.js";

const tokenA = "0x1111111111111111111111111111111111111111" as const;
const tokenB = "0x2222222222222222222222222222222222222222" as const;

const quote: MerchantMoeQuote = {
  protocolId: "merchant-moe",
  chainId: 5000,
  quoter: "0x501b8AFd35df20f531fF45F6f695793AC3316c85",
  router: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a",
  route: [tokenA, tokenB],
  pairs: ["0x3333333333333333333333333333333333333333"],
  binSteps: [25n],
  versions: [3],
  amounts: [100n, 95n],
  virtualAmountsWithoutSlippage: [100n, 98n],
  fees: [1n],
  amountIn: 100n,
  amountOut: 95n,
};

describe("Merchant Moe quote smoke", () => {
  it("parses route and raw amount env", () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA}, ${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "100",
    });
    expect(config.route).toEqual([tokenA, tokenB]);
    expect(config.amountIn).toBe(100n);
  });

  it("rejects missing or unsafe quote config", () => {
    expect(() => parseMerchantMoeQuoteSmokeConfig({})).toThrow(/MERCHANT_MOE_ROUTE/);
    expect(() =>
      parseMerchantMoeQuoteSmokeConfig({
        MERCHANT_MOE_ROUTE: tokenA,
        MERCHANT_MOE_AMOUNT_IN_WEI: "100",
      }),
    ).toThrow(/tokenIn,tokenOut/);
    expect(() =>
      parseMerchantMoeQuoteSmokeConfig({
        MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
        MERCHANT_MOE_AMOUNT_IN_WEI: "0",
      }),
    ).toThrow(/positive/);
  });

  it("formats quotes with an explicit no-execution warning", () => {
    const output = formatMerchantMoeQuote(quote);
    expect(output).toContain("amountOut: 95");
    expect(output).toContain("binSteps: 25");
    expect(output).toContain("execution: disabled");
  });

  it("runs against an injected read-only adapter", async () => {
    const writes: string[] = [];
    const adapter = {
      async quoteExactInput(input: { route: readonly `0x${string}`[]; amountIn: bigint }) {
        expect(input.route).toEqual([tokenA, tokenB]);
        expect(input.amountIn).toBe(100n);
        return quote;
      },
    };

    const result = await runMerchantMoeQuoteSmoke(
      adapter,
      {
        MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
        MERCHANT_MOE_AMOUNT_IN_WEI: "100",
      },
      (message) => writes.push(message),
    );

    expect(result.amountOut).toBe(95n);
    expect(writes[0]).toContain("[merchant-moe] read-only quote smoke");
  });
});
