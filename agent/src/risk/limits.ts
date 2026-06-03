export interface RiskLimits {
  maxDexOracleDeviationBps: bigint;
  maxPositionBps: bigint;
  maxTradeValueBps: bigint;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDexOracleDeviationBps: 300n,
  maxPositionBps: 7_000n,
  maxTradeValueBps: 2_500n,
};

function parseBpsEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer basis-point value`);
  const parsed = BigInt(raw);
  if (parsed > 10_000n) throw new Error(`${name} cannot exceed 10000 bps`);
  return parsed;
}

export function loadRiskLimitsFromEnv(): RiskLimits {
  return {
    maxDexOracleDeviationBps: parseBpsEnv(
      "RISK_MAX_DEX_ORACLE_DEVIATION_BPS",
      DEFAULT_RISK_LIMITS.maxDexOracleDeviationBps,
    ),
    maxPositionBps: parseBpsEnv("RISK_MAX_POSITION_BPS", DEFAULT_RISK_LIMITS.maxPositionBps),
    maxTradeValueBps: parseBpsEnv("RISK_MAX_TRADE_VALUE_BPS", DEFAULT_RISK_LIMITS.maxTradeValueBps),
  };
}
