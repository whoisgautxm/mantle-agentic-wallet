import type { PriceSnapshot } from "./types.js";

export interface OracleRouter {
  getPrice(pair: string): Promise<PriceSnapshot>;
}

export function createMockDexOracleRouter(
  readPrice: () => Promise<bigint>,
  maxAgeSeconds = 300n,
): OracleRouter {
  return {
    async getPrice(pair: string): Promise<PriceSnapshot> {
      return {
        pair,
        priceWei: await readPrice(),
        source: "mockdex",
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        stale: false,
        maxAgeSeconds,
      };
    },
  };
}
