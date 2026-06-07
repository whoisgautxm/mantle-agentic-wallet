import type { MarketFeatures, MarketRegime } from "./marketFeatures.js";

export interface DecisionAnalysis {
  regime: MarketRegime;
  confidence: number;
  expectedEdgeBps: number;
  sizePercent: number;
  invalidationCondition: string;
  marketFeatures?: MarketFeatures;
}

export type Decision =
  | { kind: "hold"; rationale: string; analysis?: DecisionAnalysis }
  | {
      kind: "execute";
      target: `0x${string}`;
      valueWei: bigint;
      calldata: `0x${string}`;
      rationale: string;
      action?: "pay" | "buy" | "sell";
      amountTokenWei?: bigint;
      outAsset?: `0x${string}`;
      minOutWei?: bigint;
      expectedOutWei?: bigint;
      analysis?: DecisionAnalysis;
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
  // Block the snapshot was pinned to; all fields above are read at this block (atomic observation).
  blockNumber?: bigint;
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}
