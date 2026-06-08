import { pathToFileURL } from "url";
import { loadProjectEnv } from "./projectEnv.js";
import {
  DEFAULT_LENDING_HEALTH_LIMITS,
  evaluateLendingHealth,
} from "./protocols/lending/health.js";
import type {
  LendingAssetPosition,
  LendingHealthLimits,
  LendingMarketSnapshot,
  LendingPositionSnapshot,
  LendingProtocolId,
} from "./protocols/lending/types.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

loadProjectEnv();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

interface LendingReadinessInput {
  position: LendingPositionSnapshot;
  markets: LendingMarketSnapshot[];
  limits: LendingHealthLimits;
}

function parseProtocolId(raw: unknown, fallback: LendingProtocolId = "lendle"): LendingProtocolId {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).toLowerCase();
  if (value === "lendle" || value === "init" || value === "custom") return value;
  throw new Error("lending protocol id must be lendle, init, or custom");
}

function parseAccount(raw: unknown): `0x${string}` | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw);
  if (!ADDRESS_RE.test(value)) throw new Error("lending account must be a 20-byte hex address");
  return value as `0x${string}`;
}

function parseBigint(raw: unknown, label: string): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  throw new Error(`${label} must be a non-negative integer`);
}

function parseOptionalBigint(raw: unknown, label: string): bigint | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return parseBigint(raw, label);
}

function parseBool(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "boolean") return raw;
  const value = String(raw).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`boolean value expected, got ${String(raw)}`);
}

function parseJson<T>(raw: string | undefined, fallback: T, label: string): T {
  if (!raw?.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const e = error as Error;
    throw new Error(`${label} must be valid JSON: ${e.message}`);
  }
}

function parseAsset(raw: any, index: number): LendingAssetPosition {
  if (!raw || typeof raw !== "object") throw new Error(`lending asset ${index} must be an object`);
  if (!raw.symbol) throw new Error(`lending asset ${index} is missing symbol`);
  return {
    symbol: String(raw.symbol),
    suppliedValueWei: parseBigint(raw.suppliedValueWei ?? "0", `assets[${index}].suppliedValueWei`),
    debtValueWei: parseBigint(raw.debtValueWei ?? "0", `assets[${index}].debtValueWei`),
    liquidationThresholdBps: parseBigint(raw.liquidationThresholdBps ?? "0", `assets[${index}].liquidationThresholdBps`),
  };
}

function parsePosition(raw: any, env: NodeJS.ProcessEnv): LendingPositionSnapshot {
  if (!raw || typeof raw !== "object") {
    return {
      protocolId: parseProtocolId(env.LENDING_PROTOCOL_ID),
      account: parseAccount(env.LENDING_ACCOUNT),
      assets: [],
    };
  }

  const assets = Array.isArray(raw.assets) ? raw.assets.map(parseAsset) : [];
  return {
    protocolId: parseProtocolId(raw.protocolId, parseProtocolId(env.LENDING_PROTOCOL_ID)),
    account: parseAccount(raw.account ?? env.LENDING_ACCOUNT),
    assets,
  };
}

function parseMarket(raw: any, index: number, fallbackProtocolId: LendingProtocolId): LendingMarketSnapshot {
  if (!raw || typeof raw !== "object") throw new Error(`lending market ${index} must be an object`);
  if (!raw.marketId) throw new Error(`lending market ${index} is missing marketId`);
  if (!raw.symbol) throw new Error(`lending market ${index} is missing symbol`);
  return {
    protocolId: parseProtocolId(raw.protocolId, fallbackProtocolId),
    marketId: String(raw.marketId),
    symbol: String(raw.symbol),
    utilizationBps: parseOptionalBigint(raw.utilizationBps, `markets[${index}].utilizationBps`),
    supplyCapUsedBps: parseOptionalBigint(raw.supplyCapUsedBps, `markets[${index}].supplyCapUsedBps`),
    borrowCapUsedBps: parseOptionalBigint(raw.borrowCapUsedBps, `markets[${index}].borrowCapUsedBps`),
    paused: parseBool(raw.paused),
    frozen: parseBool(raw.frozen),
  };
}

function parseLimit(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  return parseOptionalBigint(env[key], key) ?? fallback;
}

export function parseLendingReadinessInput(env = process.env): LendingReadinessInput {
  const positionJson = parseJson<any | undefined>(env.LENDING_POSITION_JSON, undefined, "LENDING_POSITION_JSON");
  const position = parsePosition(positionJson, env);
  const marketJson = parseJson<any[]>(env.LENDING_MARKETS_JSON, [], "LENDING_MARKETS_JSON");
  if (!Array.isArray(marketJson)) throw new Error("LENDING_MARKETS_JSON must be an array");

  return {
    position,
    markets: marketJson.map((market, index) => parseMarket(market, index, position.protocolId)),
    limits: {
      minHealthFactorBps: parseLimit(env, "LENDING_MIN_HEALTH_FACTOR_BPS", DEFAULT_LENDING_HEALTH_LIMITS.minHealthFactorBps),
      warnHealthFactorBps: parseLimit(env, "LENDING_WARN_HEALTH_FACTOR_BPS", DEFAULT_LENDING_HEALTH_LIMITS.warnHealthFactorBps),
      maxMarketUtilizationBps: parseLimit(
        env,
        "LENDING_MAX_MARKET_UTILIZATION_BPS",
        DEFAULT_LENDING_HEALTH_LIMITS.maxMarketUtilizationBps,
      ),
      maxCapUsageBps: parseLimit(env, "LENDING_MAX_CAP_USAGE_BPS", DEFAULT_LENDING_HEALTH_LIMITS.maxCapUsageBps),
    },
  };
}

function maybe(value: bigint | undefined, fallback = "none"): string {
  return value === undefined ? fallback : value.toString();
}

export function formatLendingReadiness(report: ReturnType<typeof evaluateLendingHealth>): string {
  return [
    "[lending] read-only health readiness",
    `protocol: ${report.protocolId}`,
    `ok: ${report.ok}`,
    `status: ${report.status}`,
    `account: ${report.account ?? "none"}`,
    `suppliedValueWei: ${report.suppliedValueWei}`,
    `debtValueWei: ${report.debtValueWei}`,
    `weightedLiquidationThresholdBps: ${report.weightedLiquidationThresholdBps}`,
    `healthFactorBps: ${maybe(report.healthFactorBps, "no debt")}`,
    `liquidationBufferBps: ${maybe(report.liquidationBufferBps)}`,
    `marketsChecked: ${report.marketsChecked}`,
    "findings:",
    ...(report.findings.length
      ? report.findings.map((item) => `- ${item.ruleId} [${item.severity}]: ${item.reason}`)
      : ["- none"]),
    "nextSteps:",
    ...report.nextSteps.map((step) => `- ${step}`),
    "execution: disabled; this command never builds or submits lending calldata",
  ].join("\n");
}

export async function runLendingReadiness(
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
): Promise<ReturnType<typeof evaluateLendingHealth>> {
  const input = parseLendingReadinessInput(env);
  const report = evaluateLendingHealth(input.position, input.markets, input.limits);
  write(formatLendingReadiness(report));
  try {
    await trace.append("lending.readiness", {
      protocolId: report.protocolId,
      mode: report.mode,
      report,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[lending] readiness trace write failed:", e?.message ?? "unknown error");
  }
  return report;
}

export async function main(): Promise<void> {
  const report = await runLendingReadiness();
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[lending] readiness failed: ${e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
