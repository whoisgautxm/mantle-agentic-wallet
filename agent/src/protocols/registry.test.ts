import { describe, expect, it } from "vitest";
import { createMockDexAdapter } from "./mockDexAdapter.js";
import { createProtocolRegistry } from "./registry.js";
import type { ReadOnlyProtocolAdapter } from "./types.js";

const dex = "0x3333333333333333333333333333333333333333" as const;
const token = "0x4444444444444444444444444444444444444444" as const;

describe("ProtocolRegistry", () => {
  it("returns executable adapters and their guard metadata", () => {
    const adapter = createMockDexAdapter(dex, token, async () => 1n);
    const registry = createProtocolRegistry([adapter]);

    expect(registry.requireExecutable("mockdex")).toBe(adapter);
    expect(registry.allowedTargets()).toEqual([dex]);
    expect(registry.allowedSelectors()).toEqual(adapter.allowedSelectors);
    expect(registry.supportedActions("mockdex")).toEqual(["buy", "sell"]);
  });

  it("rejects duplicate adapter ids", () => {
    const first = createMockDexAdapter(dex, token, async () => 1n);
    const second = createMockDexAdapter(dex, token, async () => 1n);

    expect(() => createProtocolRegistry([first, second])).toThrow(/already registered/);
  });

  it("blocks unknown and read-only adapters from executable lookup", () => {
    const merchantMoe: ReadOnlyProtocolAdapter = {
      id: "merchant-moe",
      mode: "read-only",
      chainId: 5000,
      supportedActions: ["buy", "sell"],
    };
    const registry = createProtocolRegistry([merchantMoe]);

    expect(() => registry.require("missing")).toThrow(/unknown/);
    expect(() => registry.requireExecutable("merchant-moe")).toThrow(/not executable/);
    expect(registry.executableAdapters()).toEqual([]);
  });
});
