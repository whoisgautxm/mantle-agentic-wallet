import type { PriceSnapshot } from "./types.js";
import { createPythMntUsdOracleRouter, loadPythHermesConfigFromEnv } from "./pythHermes.js";

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

export function createFallbackOracleRouter(primary: OracleRouter, fallback: OracleRouter): OracleRouter {
  return {
    async getPrice(pair: string): Promise<PriceSnapshot> {
      try {
        return await primary.getPrice(pair);
      } catch (error) {
        const fallbackSnapshot = await fallback.getPrice(pair);
        const e = error as any;
        return {
          ...fallbackSnapshot,
          warnings: [`primary oracle failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`],
        };
      }
    },
  };
}

export function createOracleRouterFromEnv(readPrice: () => Promise<bigint>, env = process.env): OracleRouter {
  const mock = createMockDexOracleRouter(readPrice, BigInt(env.MOCK_ORACLE_MAX_AGE_SECONDS ?? "300"));
  const provider = (env.ORACLE_PROVIDER ?? "mockdex").toLowerCase();
  if (provider === "pyth") {
    return createFallbackOracleRouter(createPythMntUsdOracleRouter(loadPythHermesConfigFromEnv(env)), mock);
  }
  if (provider !== "mockdex") throw new Error(`unsupported ORACLE_PROVIDER: ${provider}`);
  return mock;
}
