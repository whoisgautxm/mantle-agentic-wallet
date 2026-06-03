import type { Decision } from "../types.js";

export type ProtocolAction = "buy" | "sell";
export type ProtocolMode = "execution" | "read-only";

export interface TradeIntent {
  action: ProtocolAction;
  amountMntWei?: bigint;
  amountTokenWei?: bigint;
  rationale: string;
}

export interface QuoteResult {
  protocolId: string;
  priceWei: bigint;
  expectedTokenWei?: bigint;
  expectedMntWei?: bigint;
}

export interface ExecutionPlan {
  protocolId: string;
  action: ProtocolAction;
  target: `0x${string}`;
  valueWei: bigint;
  calldata: `0x${string}`;
  amountTokenWei?: bigint;
  expectedOutWei?: bigint;
  summary: string;
}

export interface ProtocolAdapter {
  id: string;
  mode: "execution";
  supportedActions: readonly ProtocolAction[];
  target: `0x${string}`;
  allowedSelectors: readonly `0x${string}`[];
  quote(intent: TradeIntent): Promise<QuoteResult>;
  buildPlan(intent: TradeIntent, quote: QuoteResult): ExecutionPlan;
}

export interface ReadOnlyProtocolAdapter {
  id: string;
  mode: "read-only";
  supportedActions: readonly ProtocolAction[];
  chainId?: number;
}

export type ProtocolRegistryEntry = ProtocolAdapter | ReadOnlyProtocolAdapter;

export function planToDecision(plan: ExecutionPlan, rationale: string): Decision {
  return {
    kind: "execute",
    action: plan.action,
    target: plan.target,
    valueWei: plan.valueWei,
    calldata: plan.calldata,
    amountTokenWei: plan.amountTokenWei,
    rationale,
  };
}
