import { describe, expect, it } from "vitest";
import { createFallbackOracleRouter, createMockDexOracleRouter, createOracleRouterFromEnv } from "./router.js";

describe("OracleRouter", () => {
  it("uses MockDEX by default", async () => {
    const router = createOracleRouterFromEnv(async () => 2n, {});
    const snapshot = await router.getPrice("MNT/MOCK");
    expect(snapshot.source).toBe("mockdex");
    expect(snapshot.priceWei).toBe(2n);
  });

  it("falls back to MockDEX when a primary oracle request fails", async () => {
    const primary = {
      async getPrice() {
        throw new Error("Hermes unavailable");
      },
    };
    const fallback = createMockDexOracleRouter(async () => 3n);
    const router = createFallbackOracleRouter(primary, fallback);
    const snapshot = await router.getPrice("MNT/MOCK");

    expect(snapshot.source).toBe("mockdex");
    expect(snapshot.priceWei).toBe(3n);
    expect(snapshot.warnings?.[0]).toMatch(/Hermes unavailable/);
  });

  it("rejects unsupported oracle providers", () => {
    expect(() => createOracleRouterFromEnv(async () => 1n, { ORACLE_PROVIDER: "chainlink" })).toThrow(/unsupported/);
  });
});
