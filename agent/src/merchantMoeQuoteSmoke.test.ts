import { describe, expect, it } from "vitest";
import {
  buildMerchantMoeQuoteRiskReport,
  formatMerchantMoeQuote,
  parseMerchantMoeQuoteSmokeConfig,
  quoteTokenInPerTokenOutPriceWei,
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
      MERCHANT_MOE_TOKEN_IN_DECIMALS: "18",
      MERCHANT_MOE_TOKEN_OUT_DECIMALS: "6",
      MERCHANT_MOE_REFERENCE_PRICE_WEI: "1000000000000000000",
    });
    expect(config.route).toEqual([tokenA, tokenB]);
    expect(config.amountIn).toBe(100n);
    expect(config.tokenInDecimals).toBe(18);
    expect(config.tokenOutDecimals).toBe(6);
    expect(config.referenceSource).toBe("manual");
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
    expect(() =>
      parseMerchantMoeQuoteSmokeConfig({
        MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
        MERCHANT_MOE_AMOUNT_IN_WEI: "100",
        MERCHANT_MOE_MAX_DEVIATION_BPS: "10001",
      }),
    ).toThrow(/10000/);
  });

  it("normalizes quote price as token-in per token-out in e18 units", () => {
    const oneMntForTwoUsdc = {
      ...quote,
      amountIn: 10n ** 18n,
      amountOut: 2n * 10n ** 6n,
    };
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: (10n ** 18n).toString(),
      MERCHANT_MOE_TOKEN_IN_DECIMALS: "18",
      MERCHANT_MOE_TOKEN_OUT_DECIMALS: "6",
    });

    expect(quoteTokenInPerTokenOutPriceWei(oneMntForTwoUsdc, config)).toBe(5n * 10n ** 17n);
  });

  it("builds ok and blocked deviation reports", () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "100",
      MERCHANT_MOE_REFERENCE_PRICE_WEI: "1000000000000000000",
      MERCHANT_MOE_MAX_DEVIATION_BPS: "300",
    });
    const okReport = buildMerchantMoeQuoteRiskReport({ ...quote, amountIn: 100n, amountOut: 100n }, config);
    const blockedReport = buildMerchantMoeQuoteRiskReport({ ...quote, amountIn: 100n, amountOut: 50n }, config);

    expect(okReport.status).toBe("ok");
    expect(okReport.deviationBps).toBe(0n);
    expect(blockedReport.status).toBe("blocked");
    expect(blockedReport.deviationBps).toBe(10_000n);
  });

  it("formats quotes with an explicit no-execution warning", () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "100",
    });
    const output = formatMerchantMoeQuote(quote, buildMerchantMoeQuoteRiskReport(quote, config));
    expect(output).toContain("amountOut: 95");
    expect(output).toContain("binSteps: 25");
    expect(output).toContain("riskStatus: unchecked");
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
