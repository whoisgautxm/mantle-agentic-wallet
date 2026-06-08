import { pathToFileURL } from "url";
import { loadProjectEnv } from "./projectEnv.js";
import {
  buildMerchantMoeQuoteRiskReport,
  parseMerchantMoeQuoteSmokeConfig,
  resolveMerchantMoeReferencePriceWei,
  type MerchantMoeQuoteRiskReport,
  type MerchantMoeQuoteSmokeConfig,
} from "./merchantMoeQuoteSmoke.js";
import { buildExecutionProtection, loadExecutionProtectionFromEnv } from "./protocols/executionProtection.js";
import {
  createMerchantMoePublicClient,
  createMerchantMoeReadOnlyAdapter,
  loadMerchantMoeConfigFromEnv,
  type MerchantMoeQuote,
  type MerchantMoeReadOnlyAdapter,
} from "./protocols/merchantMoeReadOnlyAdapter.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

loadProjectEnv();

export interface MerchantMoeForkReadinessBlocker {
  ruleId: "DEX_ORACLE_DEVIATION" | "FORK_RPC_MISSING" | "EXECUTION_CALLDATA_DISABLED";
  severity: "warning" | "blocker" | "critical";
  reason: string;
}

export interface MerchantMoeForkReadinessReport {
  ok: boolean;
  protocolId: "merchant-moe";
  mode: "mainnet-fork-readiness";
  executionEnabled: false;
  forkSimulationEnabled: boolean;
  forkRpcConfigured: boolean;
  route: `0x${string}`[];
  amountIn: string;
  amountOut: string;
  expectedOutWei: string;
  minOutWei: string;
  slippageBps: string;
  deadlineSeconds?: string;
  quoteRisk: MerchantMoeQuoteRiskReport;
  blockers: MerchantMoeForkReadinessBlocker[];
  nextSteps: string[];
}

function forkRpcConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.MANTLE_MAINNET_FORK_RPC_URL?.trim() || env.MERCHANT_MOE_FORK_RPC_URL?.trim());
}

function forkSimulationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MERCHANT_MOE_ENABLE_FORK_SIMULATION === "true";
}

function buildBlockers(
  quoteRisk: MerchantMoeQuoteRiskReport,
  env: NodeJS.ProcessEnv,
): MerchantMoeForkReadinessBlocker[] {
  const blockers: MerchantMoeForkReadinessBlocker[] = [];
  if (quoteRisk.status === "blocked") {
    blockers.push({
      ruleId: "DEX_ORACLE_DEVIATION",
      severity: "critical",
      reason: quoteRisk.reason,
    });
  }
  if (!forkRpcConfigured(env)) {
    blockers.push({
      ruleId: "FORK_RPC_MISSING",
      severity: "warning",
      reason: "Set MANTLE_MAINNET_FORK_RPC_URL or MERCHANT_MOE_FORK_RPC_URL before running fork simulations.",
    });
  }
  blockers.push({
    ruleId: "EXECUTION_CALLDATA_DISABLED",
    severity: "blocker",
    reason: "Live Merchant Moe execution remains disabled; LBRouter calldata generation is currently limited to fork simulation.",
  });
  return blockers;
}

function nextSteps(report: Pick<MerchantMoeForkReadinessReport, "forkRpcConfigured" | "quoteRisk">): string[] {
  const steps = [];
  if (!report.forkRpcConfigured) steps.push("Configure a local/mainnet-fork RPC for Mantle mainnet simulation.");
  if (report.quoteRisk.status === "unchecked") steps.push("Configure MERCHANT_MOE_REFERENCE_SOURCE for quote-vs-oracle checks.");
  if (report.quoteRisk.status === "blocked") steps.push("Fix route/liquidity/reference price before attempting simulation.");
  steps.push("Run simulation-only LBRouter calldata through the fork gate and inspect balances, allowances, gas, and reverts.");
  steps.push("Only enable guarded execution after fork simulation, bounded allowance checks, and risk rules pass.");
  return steps;
}

export async function buildMerchantMoeForkReadinessReport(
  quote: MerchantMoeQuote,
  config: MerchantMoeQuoteSmokeConfig,
  env = process.env,
): Promise<MerchantMoeForkReadinessReport> {
  const referencePriceWei = await resolveMerchantMoeReferencePriceWei(config);
  const quoteRisk = buildMerchantMoeQuoteRiskReport(quote, config, referencePriceWei);
  const protectionConfig = loadExecutionProtectionFromEnv(env, "MERCHANT_MOE");
  const protection = buildExecutionProtection(quote.amountOut, protectionConfig);
  const blockers = buildBlockers(quoteRisk, env);
  const report = {
    ok: blockers.every((blocker) => blocker.severity === "warning"),
    protocolId: "merchant-moe" as const,
    mode: "mainnet-fork-readiness" as const,
    executionEnabled: false as const,
    forkSimulationEnabled: forkSimulationEnabled(env),
    forkRpcConfigured: forkRpcConfigured(env),
    route: quote.route,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    expectedOutWei: quote.amountOut.toString(),
    minOutWei: (protection.minOutWei ?? 0n).toString(),
    slippageBps: protection.slippageBps.toString(),
    deadlineSeconds: protection.deadlineSeconds?.toString(),
    quoteRisk,
    blockers,
  };
  return {
    ...report,
    nextSteps: nextSteps(report),
  };
}

export function formatMerchantMoeForkReadiness(report: MerchantMoeForkReadinessReport): string {
  return [
    "[merchant-moe] mainnet-fork readiness",
    `ok: ${report.ok}`,
    `route: ${report.route.join(" -> ")}`,
    `amountIn: ${report.amountIn}`,
    `expectedOutWei: ${report.expectedOutWei}`,
    `minOutWei: ${report.minOutWei}`,
    `slippageBps: ${report.slippageBps}`,
    `deadlineSeconds: ${report.deadlineSeconds ?? "none"}`,
    `quoteRisk: ${report.quoteRisk.status} (${report.quoteRisk.reason})`,
    `forkRpcConfigured: ${report.forkRpcConfigured}`,
    `forkSimulationEnabled: ${report.forkSimulationEnabled}`,
    "blockers:",
    ...(report.blockers.length
      ? report.blockers.map((blocker) => `- ${blocker.ruleId} [${blocker.severity}]: ${blocker.reason}`)
      : ["- none"]),
    "nextSteps:",
    ...report.nextSteps.map((step) => `- ${step}`),
    "execution: disabled; this command never submits transactions",
  ].join("\n");
}

export async function runMerchantMoeForkReadiness(
  adapter: Pick<MerchantMoeReadOnlyAdapter, "quoteExactInput">,
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
): Promise<MerchantMoeForkReadinessReport> {
  const config = parseMerchantMoeQuoteSmokeConfig(env);
  const quote = await adapter.quoteExactInput(config);
  const report = await buildMerchantMoeForkReadinessReport(quote, config, env);
  write(formatMerchantMoeForkReadiness(report));
  try {
    await trace.append("merchant_moe.fork_readiness", {
      protocolId: report.protocolId,
      mode: report.mode,
      report,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[merchant-moe] fork readiness trace write failed:", e?.message ?? "unknown error");
  }
  return report;
}

export async function main(): Promise<void> {
  const config = loadMerchantMoeConfigFromEnv();
  const client = createMerchantMoePublicClient(config);
  const adapter = createMerchantMoeReadOnlyAdapter(client, config);
  const report = await runMerchantMoeForkReadiness(adapter);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] fork readiness failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
