import { describe, expect, it } from "vitest";
import {
  MERCHANT_MOE_MANTLE,
  createMerchantMoeReadOnlyAdapter,
  loadMerchantMoeConfigFromEnv,
} from "./merchantMoeReadOnlyAdapter.js";

const tokenA = "0x1111111111111111111111111111111111111111" as const;
const tokenB = "0x2222222222222222222222222222222222222222" as const;

describe("MerchantMoeReadOnlyAdapter", () => {
  it("loads official Mantle contract defaults", () => {
    const config = loadMerchantMoeConfigFromEnv({});
    expect(config.chainId).toBe(5000);
    expect(config.lbQuoter).toBe(MERCHANT_MOE_MANTLE.lbQuoter);
    expect(config.lbRouter).toBe(MERCHANT_MOE_MANTLE.lbRouter);
  });

  it("reads exact-input quotes from LBQuoter", async () => {
    const client = {
      readContract: async (params: any) => {
        expect(params.address).toBe(MERCHANT_MOE_MANTLE.lbQuoter);
        expect(params.functionName).toBe("findBestPathFromAmountIn");
        expect(params.args[0]).toEqual([tokenA, tokenB]);
        expect(params.args[1]).toBe(100n);
        return {
          route: [tokenA, tokenB],
          pairs: ["0x3333333333333333333333333333333333333333"],
          binSteps: [25n],
          versions: [3],
          amounts: [100n, 95n],
          virtualAmountsWithoutSlippage: [100n, 98n],
          fees: [1n],
        };
      },
    };

    const adapter = createMerchantMoeReadOnlyAdapter(client as any);
    const quote = await adapter.quoteExactInput({ route: [tokenA, tokenB], amountIn: 100n });
    expect(quote.protocolId).toBe("merchant-moe");
    expect(quote.amountOut).toBe(95n);
    expect(quote.pairs).toHaveLength(1);
    expect(quote.router).toBe(MERCHANT_MOE_MANTLE.lbRouter);
  });

  it("rejects invalid quote input", async () => {
    const adapter = createMerchantMoeReadOnlyAdapter({ readContract: async () => ({ amounts: [1n] }) } as any);
    await expect(adapter.quoteExactInput({ route: [tokenA], amountIn: 100n })).rejects.toThrow(/route/);
    await expect(adapter.quoteExactInput({ route: [tokenA, tokenB], amountIn: 0n })).rejects.toThrow(/positive/);
  });

  it("refuses to build execution plans", () => {
    const adapter = createMerchantMoeReadOnlyAdapter({ readContract: async () => ({ amounts: [1n] }) } as any);
    expect(() => adapter.buildPlan()).toThrow(/read-only/i);
  });
});
