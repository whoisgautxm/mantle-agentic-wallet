import type { PriceSnapshot } from "../oracles/types.js";
import type { SimulationResult } from "../simulation/types.js";
import type { Decision, VaultState } from "../types.js";

export interface RiskInput {
  decision: Decision;
  state: VaultState;
  nowSeconds?: bigint;
  allowedTargets?: readonly `0x${string}`[];
  allowedSelectors?: readonly `0x${string}`[];
  oracle?: PriceSnapshot;
  simulation?: SimulationResult;
}

export interface RiskWarning {
  ruleId: string;
  message: string;
}

export type RiskResult =
  | { ok: true; warnings: RiskWarning[] }
  | { ok: false; ruleId: string; reason: string; severity: "blocker" | "critical" };
