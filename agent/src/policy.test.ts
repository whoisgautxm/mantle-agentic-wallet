import { describe, it, expect } from "vitest";
import { checkPolicy } from "./policy.js";
import type { Decision, VaultState } from "./types.js";

const state: VaultState = {
  balanceWei: 1_000_000n,
  spendLimitPerTx: 100n,
  dailyLimit: 250n,
  spentToday: 200n,
  windowStart: 1_000n,
  paused: false,
  tokenBalanceWei: 1_000n,
  priceWei: 2_000n,
};

const exec = (valueWei: bigint): Decision => ({
  kind: "execute",
  target: "0x1111111111111111111111111111111111111111",
  valueWei,
  calldata: "0x",
  rationale: "test",
});

const sell = (amountTokenWei: bigint): Decision => ({
  kind: "execute",
  action: "sell",
  target: "0x1111111111111111111111111111111111111111",
  valueWei: 0n,
  amountTokenWei,
  calldata: "0x",
  rationale: "test",
});

describe("checkPolicy", () => {
  it("allows a spend within all limits", () => {
    expect(checkPolicy(exec(40n), state, 1_100n).ok).toBe(true);
  });
  it("rejects over per-tx limit", () => {
    expect(checkPolicy(exec(101n), state, 1_100n).ok).toBe(false);
  });
  it("rejects when it would exceed the daily limit", () => {
    const r = checkPolicy(exec(60n), state, 1_100n);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/daily/i);
  });
  it("rejects when paused", () => {
    expect(checkPolicy(exec(10n), { ...state, paused: true }, 1_100n).ok).toBe(false);
  });
  it("rejects spend exceeding balance", () => {
    expect(checkPolicy(exec(10n), { ...state, balanceWei: 5n }, 1_100n).ok).toBe(false);
  });
  it("always allows hold", () => {
    expect(checkPolicy({ kind: "hold", rationale: "wait" }, state, 1_100n).ok).toBe(true);
  });
  it("allows a spend exactly at the per-tx limit", () => {
    // value == spendLimitPerTx (100) is allowed; reset spentToday so daily doesn't interfere
    expect(checkPolicy(exec(100n), { ...state, spentToday: 0n }, 1_100n).ok).toBe(true);
  });
  it("allows a spend that hits the daily limit exactly", () => {
    // spentToday 200 + 50 = 250 == dailyLimit -> allowed (boundary is inclusive, matching the contract)
    expect(checkPolicy(exec(50n), state, 1_100n).ok).toBe(true);
  });
  it("mirrors the contract's 24h window reset", () => {
    // The contract rolls spentToday to 0 when block.timestamp >= windowStart + 1 day.
    expect(checkPolicy(exec(100n), state, state.windowStart + 86_400n).ok).toBe(true);
  });
  it("allows a sell within the DEX token balance", () => {
    expect(checkPolicy(sell(1_000n), state, 1_100n).ok).toBe(true);
  });
  it("rejects a sell above the DEX token balance", () => {
    const r = checkPolicy(sell(1_001n), state, 1_100n);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/token balance/i);
  });
});
