export type LendingProtocolId = "lendle" | "init" | "custom";
export type LendingHealthStatus = "healthy" | "watch" | "blocked";
export type LendingFindingSeverity = "warning" | "blocker" | "critical";

export interface LendingAssetPosition {
  symbol: string;
  suppliedValueWei: bigint;
  debtValueWei: bigint;
  liquidationThresholdBps: bigint;
}

export interface LendingPositionSnapshot {
  protocolId: LendingProtocolId;
  account?: `0x${string}`;
  assets: LendingAssetPosition[];
}

export interface LendingMarketSnapshot {
  protocolId: LendingProtocolId;
  marketId: string;
  symbol: string;
  utilizationBps?: bigint;
  supplyCapUsedBps?: bigint;
  borrowCapUsedBps?: bigint;
  paused?: boolean;
  frozen?: boolean;
}

export interface LendingHealthLimits {
  minHealthFactorBps: bigint;
  warnHealthFactorBps: bigint;
  maxMarketUtilizationBps: bigint;
  maxCapUsageBps: bigint;
}

export interface LendingHealthFinding {
  ruleId:
    | "LENDING_NOT_CONFIGURED"
    | "LENDING_MARKET_PAUSED"
    | "LENDING_MARKET_FROZEN"
    | "LENDING_MARKET_UTILIZATION_HIGH"
    | "LENDING_CAP_USAGE_HIGH"
    | "LENDING_HEALTH_FACTOR_MISSING"
    | "LENDING_HEALTH_FACTOR_LOW"
    | "LENDING_HEALTH_FACTOR_WARN";
  severity: LendingFindingSeverity;
  reason: string;
}

export interface LendingHealthReport {
  ok: boolean;
  protocolId: LendingProtocolId;
  mode: "read-only-health";
  executionEnabled: false;
  status: LendingHealthStatus;
  account?: `0x${string}`;
  suppliedValueWei: bigint;
  debtValueWei: bigint;
  weightedLiquidationThresholdBps: bigint;
  collateralAtThresholdWei: bigint;
  healthFactorBps?: bigint;
  liquidationBufferBps?: bigint;
  marketsChecked: number;
  assets: LendingAssetPosition[];
  findings: LendingHealthFinding[];
  nextSteps: string[];
}
