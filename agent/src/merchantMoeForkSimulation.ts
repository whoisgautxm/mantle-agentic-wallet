import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mantle } from "viem/chains";
import { pathToFileURL } from "url";
import { buildMerchantMoeForkReadinessReport, type MerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import { parseMerchantMoeQuoteSmokeConfig, type MerchantMoeQuoteSmokeConfig } from "./merchantMoeQuoteSmoke.js";
import {
  MERCHANT_MOE_MANTLE,
  createMerchantMoePublicClient,
  createMerchantMoeReadOnlyAdapter,
  loadMerchantMoeConfigFromEnv,
  type MerchantMoeQuote,
  type MerchantMoeReadOnlyAdapter,
} from "./protocols/merchantMoeReadOnlyAdapter.js";
import type { SimulationResult } from "./simulation/types.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";
import { VAULT_ABI } from "./vault.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;

export type MerchantMoeForkSimulationMode = "router-call" | "vault-execute";

export interface MerchantMoeForkSimulationConfig {
  forkRpcUrl?: string;
  forkSimulationEnabled: boolean;
  mode: MerchantMoeForkSimulationMode;
  router: `0x${string}`;
  from?: `0x${string}`;
  vault?: `0x${string}`;
  calldata?: `0x${string}`;
  valueWei: bigint;
  rationale: string;
}

export interface MerchantMoeForkSimulationFinding {
  ruleId:
    | "FORK_RPC_MISSING"
    | "FORK_SIMULATION_DISABLED"
    | "SIMULATION_FROM_MISSING"
    | "CALLDATA_MISSING"
    | "VAULT_MISSING"
    | "QUOTE_RISK_BLOCKED"
    | "SIMULATION_FAILED"
    | "LIVE_EXECUTION_DISABLED";
  severity: "warning" | "blocker" | "critical";
  reason: string;
}

export interface MerchantMoeForkSimulationReport {
  ok: boolean;
  protocolId: "merchant-moe";
  mode: "mainnet-fork-simulation";
  simulationMode: MerchantMoeForkSimulationMode;
  executionEnabled: false;
  forkRpcConfigured: boolean;
  forkSimulationEnabled: boolean;
  simulationAttempted: boolean;
  simulationPassed: boolean;
  router: `0x${string}`;
  from?: `0x${string}`;
  vault?: `0x${string}`;
  target: `0x${string}`;
  valueWei: string;
  calldataBytes: number;
  route: `0x${string}`[];
  amountIn: string;
  expectedOutWei: string;
  minOutWei: string;
  slippageBps: string;
  quoteRisk: MerchantMoeForkReadinessReport["quoteRisk"];
  simulation?: SimulationResult;
  findings: MerchantMoeForkSimulationFinding[];
  nextSteps: string[];
}

export interface ForkSimulationClient {
  call(args: unknown): Promise<{ data?: unknown } | unknown>;
  estimateGas?(args: unknown): Promise<bigint>;
  simulateContract?(args: unknown): Promise<{ result?: unknown }>;
  estimateContractGas?(args: unknown): Promise<bigint>;
}

function asAddress(raw: string | undefined, label: string): `0x${string}` | undefined {
  if (!raw?.trim()) return undefined;
  if (!ADDRESS_RE.test(raw.trim())) throw new Error(`${label} must be a 20-byte hex address`);
  return raw.trim() as `0x${string}`;
}

function asCalldata(raw: string | undefined, label: string): `0x${string}` | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (!HEX_RE.test(value) || value.length < 10) throw new Error(`${label} must be 0x-prefixed calldata`);
  return value as `0x${string}`;
}

function parseWei(raw: string | undefined, label: string, fallback = 0n): bigint {
  if (!raw?.trim()) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw.trim());
}

function forkRpcUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.MERCHANT_MOE_FORK_RPC_URL?.trim() || env.MANTLE_MAINNET_FORK_RPC_URL?.trim();
}

function parseMode(env: NodeJS.ProcessEnv, vault: `0x${string}` | undefined): MerchantMoeForkSimulationMode {
  const raw = env.MERCHANT_MOE_SIMULATION_MODE?.trim().toLowerCase();
  if (!raw) return vault ? "vault-execute" : "router-call";
  if (raw === "router-call" || raw === "vault-execute") return raw;
  throw new Error("MERCHANT_MOE_SIMULATION_MODE must be router-call or vault-execute");
}

export function loadMerchantMoeForkSimulationConfig(env = process.env): MerchantMoeForkSimulationConfig {
  const vault = asAddress(env.MERCHANT_MOE_SIMULATION_VAULT, "MERCHANT_MOE_SIMULATION_VAULT");
  return {
    forkRpcUrl: forkRpcUrl(env),
    forkSimulationEnabled: env.MERCHANT_MOE_ENABLE_FORK_SIMULATION === "true",
    mode: parseMode(env, vault),
    router: asAddress(env.MERCHANT_MOE_LB_ROUTER ?? MERCHANT_MOE_MANTLE.lbRouter, "MERCHANT_MOE_LB_ROUTER")!,
    from: asAddress(env.MERCHANT_MOE_SIMULATION_FROM, "MERCHANT_MOE_SIMULATION_FROM"),
    vault,
    calldata: asCalldata(env.MERCHANT_MOE_SWAP_CALLDATA, "MERCHANT_MOE_SWAP_CALLDATA"),
    valueWei: parseWei(env.MERCHANT_MOE_SIMULATION_VALUE_WEI, "MERCHANT_MOE_SIMULATION_VALUE_WEI"),
    rationale: env.MERCHANT_MOE_SIMULATION_RATIONALE ?? "Merchant Moe mainnet-fork simulation",
  };
}

function calldataBytes(calldata: `0x${string}` | undefined): number {
  if (!calldata) return 0;
  return (calldata.length - 2) / 2;
}

function errorReason(error: unknown): string {
  const e = error as any;
  return e?.shortMessage ?? e?.details ?? e?.message ?? "simulation failed";
}

function hexReturnData(result: unknown): `0x${string}` | undefined {
  if (typeof result === "string" && result.startsWith("0x")) return result as `0x${string}`;
  if (result && typeof result === "object" && typeof (result as any).data === "string") return (result as any).data;
  return undefined;
}

function baseFindings(
  readiness: MerchantMoeForkReadinessReport,
  config: MerchantMoeForkSimulationConfig,
): MerchantMoeForkSimulationFinding[] {
  const findings: MerchantMoeForkSimulationFinding[] = [];
  if (!config.forkRpcUrl) {
    findings.push({
      ruleId: "FORK_RPC_MISSING",
      severity: "blocker",
      reason: "Set MANTLE_MAINNET_FORK_RPC_URL or MERCHANT_MOE_FORK_RPC_URL before fork simulation.",
    });
  }
  if (!config.forkSimulationEnabled) {
    findings.push({
      ruleId: "FORK_SIMULATION_DISABLED",
      severity: "blocker",
      reason: "Set MERCHANT_MOE_ENABLE_FORK_SIMULATION=true to allow this command to call the fork RPC.",
    });
  }
  if (!config.from) {
    findings.push({
      ruleId: "SIMULATION_FROM_MISSING",
      severity: "blocker",
      reason: "Set MERCHANT_MOE_SIMULATION_FROM to the fork account that should simulate the swap.",
    });
  }
  if (!config.calldata) {
    findings.push({
      ruleId: "CALLDATA_MISSING",
      severity: "blocker",
      reason: "Set MERCHANT_MOE_SWAP_CALLDATA after a safe LBRouter calldata builder or fixture is available.",
    });
  }
  if (config.mode === "vault-execute" && !config.vault) {
    findings.push({
      ruleId: "VAULT_MISSING",
      severity: "blocker",
      reason: "Set MERCHANT_MOE_SIMULATION_VAULT to simulate AgentVault.execute on a fork.",
    });
  }
  if (readiness.quoteRisk.status === "blocked") {
    findings.push({
      ruleId: "QUOTE_RISK_BLOCKED",
      severity: "critical",
      reason: readiness.quoteRisk.reason,
    });
  }
  findings.push({
    ruleId: "LIVE_EXECUTION_DISABLED",
    severity: "warning",
    reason: "Fork simulation only; live Merchant Moe execution remains disabled until calldata, allowances, and risk tests pass.",
  });
  return findings;
}

function canAttempt(config: MerchantMoeForkSimulationConfig, findings: readonly MerchantMoeForkSimulationFinding[]): boolean {
  return (
    config.forkSimulationEnabled &&
    Boolean(config.forkRpcUrl) &&
    Boolean(config.from) &&
    Boolean(config.calldata) &&
    (config.mode === "router-call" || Boolean(config.vault)) &&
    !findings.some((finding) => finding.severity === "critical")
  );
}

async function simulateRouterCall(
  client: ForkSimulationClient,
  router: `0x${string}`,
  config: MerchantMoeForkSimulationConfig,
): Promise<SimulationResult> {
  const call = {
    account: config.from,
    to: router,
    data: config.calldata,
    value: config.valueWei,
  };
  try {
    const result = await client.call(call);
    const warnings: string[] = [];
    let gasEstimate: bigint | undefined;
    if (client.estimateGas) {
      try {
        gasEstimate = await client.estimateGas(call);
      } catch (error) {
        warnings.push(`gas estimate unavailable: ${errorReason(error)}`);
      }
    }
    return { ok: true, returnData: hexReturnData(result), gasEstimate, warnings };
  } catch (error) {
    const reason = errorReason(error);
    return { ok: false, reason, revertReason: reason, warnings: [] };
  }
}

async function simulateVaultExecute(
  client: ForkSimulationClient,
  router: `0x${string}`,
  config: MerchantMoeForkSimulationConfig,
): Promise<SimulationResult> {
  const call = {
    address: config.vault,
    abi: VAULT_ABI,
    functionName: "execute",
    account: config.from,
    args: [router, config.valueWei, config.calldata, config.rationale],
  };
  try {
    if (!client.simulateContract) throw new Error("fork client does not support simulateContract");
    const result = await client.simulateContract(call);
    const warnings: string[] = [];
    let gasEstimate: bigint | undefined;
    if (client.estimateContractGas) {
      try {
        gasEstimate = await client.estimateContractGas(call);
      } catch (error) {
        warnings.push(`gas estimate unavailable: ${errorReason(error)}`);
      }
    }
    return { ok: true, returnData: hexReturnData(result.result), gasEstimate, warnings };
  } catch (error) {
    const reason = errorReason(error);
    return { ok: false, reason, revertReason: reason, warnings: [] };
  }
}

function createForkClient(config: MerchantMoeForkSimulationConfig): ForkSimulationClient | undefined {
  if (!config.forkRpcUrl) return undefined;
  return createPublicClient({
    chain: mantle,
    transport: http(config.forkRpcUrl),
  }) as ForkSimulationClient;
}

function nextSteps(report: Pick<MerchantMoeForkSimulationReport, "simulationPassed" | "findings">): string[] {
  const steps = [];
  if (report.findings.some((finding) => finding.ruleId === "FORK_RPC_MISSING")) {
    steps.push("Configure a local/mainnet-fork RPC for Mantle mainnet simulation.");
  }
  if (report.findings.some((finding) => finding.ruleId === "CALLDATA_MISSING")) {
    steps.push("Add or provide Merchant Moe LBRouter calldata with minOut/deadline before attempting fork simulation.");
  }
  if (report.findings.some((finding) => finding.ruleId === "SIMULATION_FROM_MISSING")) {
    steps.push("Choose a fork account/vault-like address with the token balances and approvals needed for the swap.");
  }
  if (report.findings.some((finding) => finding.ruleId === "SIMULATION_FAILED")) {
    steps.push("Inspect revert reason, balances, approvals, minOut, route liquidity, and deadline on the fork.");
  }
  if (report.simulationPassed) {
    steps.push("Promote this calldata fixture into a regression test before building live execution support.");
  }
  steps.push("Keep live execution disabled until fork simulation, bounded allowances, and risk evals all pass.");
  return steps;
}

export async function buildMerchantMoeForkSimulationReport(
  readiness: MerchantMoeForkReadinessReport,
  simulationConfig: MerchantMoeForkSimulationConfig,
  client: ForkSimulationClient | undefined = createForkClient(simulationConfig),
): Promise<MerchantMoeForkSimulationReport> {
  const findings = baseFindings(readiness, simulationConfig);
  let simulation: SimulationResult | undefined;
  let simulationAttempted = false;

  if (canAttempt(simulationConfig, findings)) {
    simulationAttempted = true;
    simulation =
      simulationConfig.mode === "vault-execute"
        ? await simulateVaultExecute(client!, simulationConfig.router, simulationConfig)
        : await simulateRouterCall(client!, simulationConfig.router, simulationConfig);
  }

  if (simulation && !simulation.ok) {
    findings.push({
      ruleId: "SIMULATION_FAILED",
      severity: "blocker",
      reason: simulation.reason ?? simulation.revertReason ?? "fork simulation failed",
    });
  }

  const simulationPassed = Boolean(simulation?.ok);
  const hardBlock = findings.some((finding) => finding.severity === "blocker" || finding.severity === "critical");
  const report = {
    ok: simulationPassed && !hardBlock,
    protocolId: "merchant-moe" as const,
    mode: "mainnet-fork-simulation" as const,
    simulationMode: simulationConfig.mode,
    executionEnabled: false as const,
    forkRpcConfigured: Boolean(simulationConfig.forkRpcUrl),
    forkSimulationEnabled: simulationConfig.forkSimulationEnabled,
    simulationAttempted,
    simulationPassed,
    router: simulationConfig.router,
    from: simulationConfig.from,
    vault: simulationConfig.vault,
    target: simulationConfig.mode === "vault-execute" ? simulationConfig.vault ?? simulationConfig.router : simulationConfig.router,
    valueWei: simulationConfig.valueWei.toString(),
    calldataBytes: calldataBytes(simulationConfig.calldata),
    route: readiness.route,
    amountIn: readiness.amountIn,
    expectedOutWei: readiness.expectedOutWei,
    minOutWei: readiness.minOutWei,
    slippageBps: readiness.slippageBps,
    quoteRisk: readiness.quoteRisk,
    simulation,
    findings,
  };

  return {
    ...report,
    nextSteps: nextSteps(report),
  };
}

export function formatMerchantMoeForkSimulation(report: MerchantMoeForkSimulationReport): string {
  return [
    "[merchant-moe] mainnet-fork simulation",
    `ok: ${report.ok}`,
    `simulationMode: ${report.simulationMode}`,
    `forkRpcConfigured: ${report.forkRpcConfigured}`,
    `forkSimulationEnabled: ${report.forkSimulationEnabled}`,
    `simulationAttempted: ${report.simulationAttempted}`,
    `simulationPassed: ${report.simulationPassed}`,
    `target: ${report.target}`,
    `from: ${report.from ?? "none"}`,
    `vault: ${report.vault ?? "none"}`,
    `calldataBytes: ${report.calldataBytes}`,
    `valueWei: ${report.valueWei}`,
    `route: ${report.route.join(" -> ")}`,
    `expectedOutWei: ${report.expectedOutWei}`,
    `minOutWei: ${report.minOutWei}`,
    `slippageBps: ${report.slippageBps}`,
    `gasEstimate: ${report.simulation?.gasEstimate?.toString() ?? "none"}`,
    `revertReason: ${report.simulation?.revertReason ?? "none"}`,
    "findings:",
    ...(report.findings.length
      ? report.findings.map((finding) => `- ${finding.ruleId} [${finding.severity}]: ${finding.reason}`)
      : ["- none"]),
    "nextSteps:",
    ...report.nextSteps.map((step) => `- ${step}`),
    "execution: disabled; this command never submits transactions",
  ].join("\n");
}

export async function runMerchantMoeForkSimulation(
  adapter: Pick<MerchantMoeReadOnlyAdapter, "quoteExactInput">,
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
  client?: ForkSimulationClient,
): Promise<MerchantMoeForkSimulationReport> {
  const quoteConfig: MerchantMoeQuoteSmokeConfig = parseMerchantMoeQuoteSmokeConfig(env);
  const quote: MerchantMoeQuote = await adapter.quoteExactInput(quoteConfig);
  const readiness = await buildMerchantMoeForkReadinessReport(quote, quoteConfig, env);
  const simulationConfig = loadMerchantMoeForkSimulationConfig(env);
  const report = await buildMerchantMoeForkSimulationReport(readiness, simulationConfig, client);
  write(formatMerchantMoeForkSimulation(report));
  try {
    await trace.append("merchant_moe.fork_simulation", {
      protocolId: report.protocolId,
      mode: report.mode,
      report,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[merchant-moe] fork simulation trace write failed:", e?.message ?? "unknown error");
  }
  return report;
}

export async function main(): Promise<void> {
  const config = loadMerchantMoeConfigFromEnv();
  const publicClient = createMerchantMoePublicClient(config);
  const adapter = createMerchantMoeReadOnlyAdapter(publicClient, config);
  const report = await runMerchantMoeForkSimulation(adapter);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] fork simulation failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
