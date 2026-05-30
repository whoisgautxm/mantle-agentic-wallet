export type Decision =
  | { kind: "hold"; rationale: string }
  | {
      kind: "execute";
      target: `0x${string}`;
      valueWei: bigint;
      calldata: `0x${string}`;
      rationale: string;
    };

export interface VaultState {
  balanceWei: bigint;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  paused: boolean;
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}
