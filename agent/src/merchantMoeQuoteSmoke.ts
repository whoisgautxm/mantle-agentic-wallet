import { pathToFileURL } from "url";
import { loadProjectEnv } from "./projectEnv.js";
import { createPythMntUsdOracleRouter } from "./oracles/pythHermes.js";
import {
  createMerchantMoePublicClient,
  createMerchantMoeReadOnlyAdapter,
  loadMerchantMoeConfigFromEnv,
  type MerchantMoeQuote,
  type MerchantMoeReadOnlyAdapter,
} from "./protocols/merchantMoeReadOnlyAdapter.js";
import { getMerchantMoeRoutePreset, routePresetIds } from "./protocols/merchantMoeRoutePresets.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

loadProjectEnv();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ONE = 10n ** 18n;

export interface MerchantMoeQuoteSmokeConfig {
  routePresetId?: string;
  route: `0x${string}`[];
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  maxDeviationBps: bigint;
  referencePriceWei?: bigint;
  referenceSource: "none" | "manual" | "pyth-mnt-usd";
}

export interface MerchantMoeQuoteRiskReport {
  status: "unchecked" | "ok" | "blocked";
  quotePriceWei: bigint;
  referencePriceWei?: bigint;
  deviationBps?: bigint;
  maxDeviationBps: bigint;
  referenceSource: MerchantMoeQuoteSmokeConfig["referenceSource"];
  reason: string;
}

function asAddress(value: string, label: string): `0x${string}` {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) throw new Error(`${label} must be a 20-byte hex address`);
  return trimmed as `0x${string}`;
}

function envOverride(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function parseMerchantMoeQuoteSmokeConfig(env = process.env): MerchantMoeQuoteSmokeConfig {
  const routePresetId = env.MERCHANT_MOE_ROUTE_PRESET?.trim();
  const preset = getMerchantMoeRoutePreset(routePresetId);
  if (routePresetId && !preset) {
    throw new Error(`MERCHANT_MOE_ROUTE_PRESET must be one of: ${routePresetIds().join(", ")}`);
  }

  const routeRaw = envOverride(env.MERCHANT_MOE_ROUTE) ?? preset?.route.join(",");
  if (!routeRaw?.trim()) {
    throw new Error("MERCHANT_MOE_ROUTE or MERCHANT_MOE_ROUTE_PRESET is required, e.g. tokenIn,tokenOut");
  }

  const route = routeRaw
    .split(",")
    .map((value, index) => asAddress(value, `MERCHANT_MOE_ROUTE[${index}]`));
  if (route.length < 2) throw new Error("MERCHANT_MOE_ROUTE must include at least tokenIn,tokenOut");

  const amountRaw = envOverride(env.MERCHANT_MOE_AMOUNT_IN_WEI) ?? preset?.amountInWei.toString();
  if (!amountRaw?.trim() || !/^\d+$/.test(amountRaw.trim())) {
    throw new Error("MERCHANT_MOE_AMOUNT_IN_WEI is required as a positive integer raw token amount");
  }
  const amountIn = BigInt(amountRaw.trim());
  if (amountIn <= 0n) throw new Error("MERCHANT_MOE_AMOUNT_IN_WEI must be positive");

  const tokenInDecimals = parseDecimals(
    envOverride(env.MERCHANT_MOE_TOKEN_IN_DECIMALS) ?? preset?.tokenInDecimals.toString() ?? "18",
    "MERCHANT_MOE_TOKEN_IN_DECIMALS",
  );
  const tokenOutDecimals = parseDecimals(
    envOverride(env.MERCHANT_MOE_TOKEN_OUT_DECIMALS) ?? preset?.tokenOutDecimals.toString() ?? "18",
    "MERCHANT_MOE_TOKEN_OUT_DECIMALS",
  );
  const maxDeviationBps = parseBps(
    envOverride(env.MERCHANT_MOE_MAX_DEVIATION_BPS) ?? preset?.maxDeviationBps.toString() ?? "300",
    "MERCHANT_MOE_MAX_DEVIATION_BPS",
  );
  const referencePriceWei = parseOptionalPositiveBigint(env.MERCHANT_MOE_REFERENCE_PRICE_WEI, "MERCHANT_MOE_REFERENCE_PRICE_WEI");
  const referenceSource = parseReferenceSource(envOverride(env.MERCHANT_MOE_REFERENCE_SOURCE) ?? preset?.referenceSource, referencePriceWei);

  return {
    routePresetId: preset?.id,
    route,
    amountIn,
    tokenInDecimals,
    tokenOutDecimals,
    maxDeviationBps,
    referencePriceWei,
    referenceSource,
  };
}

function parseDecimals(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error(`${label} must be between 0 and 36`);
  return value;
}

function parseBps(raw: string, label: string): bigint {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const value = BigInt(raw);
  if (value > 10_000n) throw new Error(`${label} cannot exceed 10000`);
  return value;
}

function parseOptionalPositiveBigint(raw: string | undefined, label: string): bigint | undefined {
  if (!raw?.trim()) return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a positive integer`);
  const value = BigInt(raw.trim());
  if (value <= 0n) throw new Error(`${label} must be positive`);
  return value;
}

function parseReferenceSource(
  raw: string | undefined,
  referencePriceWei: bigint | undefined,
): MerchantMoeQuoteSmokeConfig["referenceSource"] {
  const source = (raw ?? (referencePriceWei ? "manual" : "none")).toLowerCase();
  if (source === "none" || source === "manual" || source === "pyth-mnt-usd") return source;
  throw new Error("MERCHANT_MOE_REFERENCE_SOURCE must be none, manual, or pyth-mnt-usd");
}

function bigintList(values: readonly bigint[]): string {
  return values.map((value) => value.toString()).join(", ");
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function bps(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator * 10_000n) / denominator;
}

export function quoteTokenInPerTokenOutPriceWei(quote: MerchantMoeQuote, config: MerchantMoeQuoteSmokeConfig): bigint {
  if (quote.amountOut <= 0n) throw new Error("Merchant Moe quote amountOut must be positive for price checks");
  return (
    (quote.amountIn * 10n ** BigInt(config.tokenOutDecimals) * ONE) /
    (quote.amountOut * 10n ** BigInt(config.tokenInDecimals))
  );
}

export function buildMerchantMoeQuoteRiskReport(
  quote: MerchantMoeQuote,
  config: MerchantMoeQuoteSmokeConfig,
  referencePriceWei = config.referencePriceWei,
): MerchantMoeQuoteRiskReport {
  const quotePriceWei = quoteTokenInPerTokenOutPriceWei(quote, config);
  if (!referencePriceWei) {
    return {
      status: "unchecked",
      quotePriceWei,
      maxDeviationBps: config.maxDeviationBps,
      referenceSource: config.referenceSource,
      reason: "no reference price configured",
    };
  }

  const deviationBps = bps(absDiff(quotePriceWei, referencePriceWei), referencePriceWei);
  const ok = deviationBps <= config.maxDeviationBps;
  return {
    status: ok ? "ok" : "blocked",
    quotePriceWei,
    referencePriceWei,
    deviationBps,
    maxDeviationBps: config.maxDeviationBps,
    referenceSource: config.referenceSource,
    reason: ok
      ? `quote/reference deviation ${deviationBps} bps is within ${config.maxDeviationBps} bps`
      : `quote/reference deviation ${deviationBps} bps exceeds ${config.maxDeviationBps} bps`,
  };
}

export async function resolveMerchantMoeReferencePriceWei(config: MerchantMoeQuoteSmokeConfig): Promise<bigint | undefined> {
  if (config.referenceSource === "manual") return config.referencePriceWei;
  if (config.referenceSource === "pyth-mnt-usd") {
    const oracle = createPythMntUsdOracleRouter();
    const snapshot = await oracle.getPrice("MNT/USD");
    if (snapshot.stale) throw new Error("Pyth MNT/USD reference is stale");
    return snapshot.priceWei;
  }
  return undefined;
}

export function formatMerchantMoeQuote(quote: MerchantMoeQuote, risk?: MerchantMoeQuoteRiskReport): string {
  return [
    "[merchant-moe] read-only quote smoke",
    `chainId: ${quote.chainId}`,
    `quoter: ${quote.quoter}`,
    `router: ${quote.router}`,
    `route: ${quote.route.join(" -> ")}`,
    `amountIn: ${quote.amountIn.toString()}`,
    `amountOut: ${quote.amountOut.toString()}`,
    `pairs: ${quote.pairs.length ? quote.pairs.join(", ") : "none"}`,
    `binSteps: ${bigintList(quote.binSteps) || "none"}`,
    `versions: ${quote.versions.length ? quote.versions.join(", ") : "none"}`,
    `fees: ${bigintList(quote.fees) || "none"}`,
    ...(risk
      ? [
          `quotePriceWei(tokenIn/tokenOut): ${risk.quotePriceWei.toString()}`,
          `referenceSource: ${risk.referenceSource}`,
          `referencePriceWei: ${risk.referencePriceWei?.toString() ?? "none"}`,
          `deviationBps: ${risk.deviationBps?.toString() ?? "unchecked"}`,
          `riskStatus: ${risk.status}`,
          `riskReason: ${risk.reason}`,
        ]
      : []),
    "execution: disabled; this command never builds or submits swap calldata",
  ].join("\n");
}

export async function runMerchantMoeQuoteSmoke(
  adapter: Pick<MerchantMoeReadOnlyAdapter, "quoteExactInput">,
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
): Promise<MerchantMoeQuote> {
  const config = parseMerchantMoeQuoteSmokeConfig(env);
  const quote = await adapter.quoteExactInput(config);
  const referencePriceWei = await resolveMerchantMoeReferencePriceWei(config);
  const risk = buildMerchantMoeQuoteRiskReport(quote, config, referencePriceWei);
  write(formatMerchantMoeQuote(quote, risk));
  try {
    await trace.append("merchant_moe.quote_smoke", {
      protocolId: quote.protocolId,
      mode: "read-only",
      config,
      quote,
      risk,
      executionEnabled: false,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[merchant-moe] trace write failed:", e?.message ?? "unknown error");
  }
  return quote;
}

export async function main(): Promise<void> {
  const config = loadMerchantMoeConfigFromEnv();
  const client = createMerchantMoePublicClient(config);
  const adapter = createMerchantMoeReadOnlyAdapter(client, config);
  await runMerchantMoeQuoteSmoke(adapter);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] quote smoke failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
