import { describe, expect, it } from "vitest";
import {
  buildMerchantMoeAnvilArgs,
  loadMerchantMoeAnvilFixtureConfig,
} from "./merchantMoeAnvilFixture.js";

describe("Merchant Moe Anvil fixture", () => {
  it("loads a safe local fork configuration", () => {
    const config = loadMerchantMoeAnvilFixtureConfig({
      MANTLE_MAINNET_FORK_RPC_URL: "https://mantle.example.invalid",
      MERCHANT_MOE_ANVIL_PORT: "18546",
      MERCHANT_MOE_ROUTE_PRESET: "wmnt-usdc-direct",
      MERCHANT_MOE_AMOUNT_IN_WEI: "100000000000000000",
      ANVIL_BINARY: "/tmp/anvil",
    });

    expect(config).toEqual({
      forkUrl: "https://mantle.example.invalid",
      anvilBinary: "/tmp/anvil",
      host: "127.0.0.1",
      port: 18_546,
      routePreset: "wmnt-usdc-direct",
      amountInWei: "100000000000000000",
    });
    expect(buildMerchantMoeAnvilArgs(config)).toEqual([
      "--fork-url",
      "https://mantle.example.invalid",
      "--host",
      "127.0.0.1",
      "--port",
      "18546",
      "--chain-id",
      "5000",
      "--silent",
    ]);
  });

  it("requires a Mantle mainnet fork URL", () => {
    expect(() => loadMerchantMoeAnvilFixtureConfig({})).toThrow(/MANTLE_MAINNET_FORK_RPC_URL/);
  });

  it("rejects invalid local Anvil ports", () => {
    expect(() =>
      loadMerchantMoeAnvilFixtureConfig({
        MANTLE_MAINNET_FORK_RPC_URL: "https://mantle.example.invalid",
        MERCHANT_MOE_ANVIL_PORT: "80",
      }),
    ).toThrow(/between 1024 and 65535/);
  });

  it("reports a missing Anvil binary without crashing the process", async () => {
    const { runMerchantMoeAnvilFixture } = await import("./merchantMoeAnvilFixture.js");

    await expect(
      runMerchantMoeAnvilFixture(
        {
          MANTLE_MAINNET_FORK_RPC_URL: "https://mantle.example.invalid",
          ANVIL_BINARY: "/definitely/missing/anvil",
        },
        () => undefined,
        {
          enabled: false,
          path: "/tmp/merchant-moe-anvil-fixture-test.jsonl",
          append: async () => undefined,
        },
      ),
    ).rejects.toThrow(/Anvil failed to start/);
  });
});
