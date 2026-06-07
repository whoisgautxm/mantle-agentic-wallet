import { describe, expect, it, vi } from "vitest";

// Regression test for the live-run report section 9 "369 bps split-snapshot" bug: every field of a
// vault observation must be read at a single pinned block. We simulate the keeper moving the price
// between blocks (a later block reports a different price) and assert readVaultState never mixes them.

const h = vi.hoisted(() => ({ seenBlocks: [] as (bigint | undefined)[] }));

vi.mock("./config.js", () => {
  const readContract = vi.fn(async ({ functionName, blockNumber }: any) => {
    h.seenBlocks.push(blockNumber);
    switch (functionName) {
      case "price":
        // Pinned block 100 -> canonical price; any other/unpinned block would leak a different value.
        return blockNumber === 100n ? 2_000_000_000_000_000_000n : 9_999n;
      case "spendLimitPerTx":
        return 100n;
      case "dailyLimit":
        return 200n;
      case "spentToday":
        return 0n;
      case "windowStart":
        return 1n;
      case "paused":
        return false;
      case "balanceOf":
        return 7n;
      default:
        return 0n;
    }
  });
  return {
    publicClient: {
      getBlockNumber: vi.fn(async () => 100n),
      getBalance: vi.fn(async ({ blockNumber }: any) => {
        h.seenBlocks.push(blockNumber);
        return 5n;
      }),
      readContract,
    },
    walletClient: {},
    aiVaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dexAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
    mockTokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
});

const { readVaultState } = await import("./chain.js");
const VAULT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

describe("readVaultState atomic block-pinned observation (P0.1 regression)", () => {
  it("reads every field at one block and returns the canonical pinned price", async () => {
    h.seenBlocks.length = 0;
    const state = await readVaultState(VAULT);
    expect(state.blockNumber).toBe(100n);
    // If any read had leaked from a later/unpinned block, price would be 9_999n.
    expect(state.priceWei).toBe(2_000_000_000_000_000_000n);
    expect(h.seenBlocks.length).toBeGreaterThanOrEqual(7);
    expect(h.seenBlocks.every((block) => block === 100n)).toBe(true);
  });

  it("honors a caller-supplied pinned block for cross-vault alignment", async () => {
    h.seenBlocks.length = 0;
    const state = await readVaultState(VAULT, 100n);
    expect(state.blockNumber).toBe(100n);
    expect(h.seenBlocks.every((block) => block === 100n)).toBe(true);
  });
});
