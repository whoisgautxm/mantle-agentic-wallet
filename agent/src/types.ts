export type Decision =
  | { kind: "hold"; rationale: string }
  | {
      kind: "execute";
      target: `0x${string}`;
      valueWei: bigint;
      calldata: `0x${string}`;
      rationale: string;
      action?: "pay" | "buy" | "sell";
      amountTokenWei?: bigint;
    };

export interface VaultState {
  balanceWei: bigint;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  windowStart: bigint;
  paused: boolean;
  tokenBalanceWei: bigint;
  priceWei: bigint;
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}
