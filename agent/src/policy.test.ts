import { describe, it, expect } from "vitest";
import { checkPolicy } from "./policy.js";
import type { Decision, VaultState } from "./types.js";

const state: VaultState = {
  balanceWei: 1_000_000n,
  spendLimitPerTx: 100n,
  dailyLimit: 250n,
  spentToday: 200n,
  paused: false,
};

const exec = (valueWei: bigint): Decision => ({
  kind: "execute",
  target: "0x1111111111111111111111111111111111111111",
  valueWei,
  calldata: "0x",
  rationale: "test",
});

describe("checkPolicy", () => {
  it("allows a spend within all limits", () => {
    expect(checkPolicy(exec(40n), state).ok).toBe(true);
  });
  it("rejects over per-tx limit", () => {
    expect(checkPolicy(exec(101n), state).ok).toBe(false);
  });
  it("rejects when it would exceed the daily limit", () => {
    const r = checkPolicy(exec(60n), state);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/daily/i);
  });
  it("rejects when paused", () => {
    expect(checkPolicy(exec(10n), { ...state, paused: true }).ok).toBe(false);
  });
  it("rejects spend exceeding balance", () => {
    expect(checkPolicy(exec(10n), { ...state, balanceWei: 5n }).ok).toBe(false);
  });
  it("always allows hold", () => {
    expect(checkPolicy({ kind: "hold", rationale: "wait" }, state).ok).toBe(true);
  });
});
