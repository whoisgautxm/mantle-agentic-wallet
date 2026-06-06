import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mantle } from "viem/chains";
import { pathToFileURL } from "url";
import { buildMerchantMoeForkReadinessReport, type MerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import { parseMerchantMoeQuoteSmokeConfig, type MerchantMoeQuoteSmokeConfig } from "./merchantMoeQuoteSmoke.js";
import { classifyAllowance } from "./portfolio/allowances.js";
import { ERC20_ABI } from "./portfolio/erc20.js";
import type { AllowanceStatus } from "./portfolio/types.js";
import { buildMerchantMoeSwapExactTokensForTokensCalldata } from "./protocols/merchantMoeCalldata.js";
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
const DEFAULT_DEADLINE_SECONDS = 1_200n;

export type MerchantMoeForkSimulationMode = "router-call" | "vault-execute";
export type MerchantMoeForkSimulationCalldataSource = "env" | "auto" | "missing" | "build-error";

export interface MerchantMoeForkSimulationConfig {
  forkRpcUrl?: string;
  forkSimulationEnabled: boolean;
  fixtureMode?: boolean;
  mode: MerchantMoeForkSimulationMode;
  router: `0x${string}`;
  from?: `0x${string}`;
  vault?: `0x${string}`;
  calldata?: `0x${string}`;
  calldataSource: MerchantMoeForkSimulationCalldataSource;
  calldataBuildError?: string;
  recipient?: `0x${string}`;
  deadline?: bigint;
  valueWei: bigint;
  rationale: string;
}

export interface MerchantMoeForkSimulationFinding {
  ruleId:
    | "FORK_RPC_MISSING"
    | "FORK_SIMULATION_DISABLED"
    | "SIMULATION_FROM_MISSING"
    | "CALLDATA_MISSING"
    | "CALLDATA_BUILD_FAILED"
    | "ERC20_PREFLIGHT_FAILED"
    | "TOKEN_BALANCE_TOO_LOW"
    | "ROUTER_ALLOWANCE_TOO_LOW"
    | "ROUTER_ALLOWANCE_UNSAFE"
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
  fixtureMode: boolean;
  forkRpcConfigured: boolean;
  forkSimulationEnabled: boolean;
  simulationAttempted: boolean;
  simulationPassed: boolean;
  router: `0x${string}`;
  from?: `0x${string}`;
  vault?: `0x${string}`;
  target: `0x${string}`;
  calldataSource: MerchantMoeForkSimulationCalldataSource;
  recipient?: `0x${string}`;
  deadline?: string;
  valueWei: string;
  calldataBytes: number;
  route: `0x${string}`[];
  amountIn: string;
  expectedOutWei: string;
  minOutWei: string;
  slippageBps: string;
  quoteRisk: MerchantMoeForkReadinessReport["quoteRisk"];
  preflight?: MerchantMoeForkPreflight;
  simulation?: SimulationResult;
  findings: MerchantMoeForkSimulationFinding[];
  nextSteps: string[];
}

export interface ForkSimulationClient {
  readContract?(args: unknown): Promise<unknown>;
  call(args: unknown): Promise<{ data?: unknown } | unknown>;
  estimateGas?(args: unknown): Promise<bigint>;
  simulateContract?(args: unknown): Promise<{ result?: unknown }>;
  estimateContractGas?(args: unknown): Promise<bigint>;
}

export interface MerchantMoeForkPreflight {
  status: "unchecked" | "ok" | "blocked";
  tokenIn: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  requiredAmountIn: string;
  balanceRaw?: string;
  allowanceRaw?: string;
  allowanceStatus?: AllowanceStatus;
  balanceOk?: boolean;
  allowanceOk?: boolean;
  warnings: string[];
  reason: string;
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

function parseOptionalPositiveInteger(raw: string | undefined, label: string): bigint | undefined {
  if (!raw?.trim()) return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be a positive integer`);
  const value = BigInt(raw.trim());
  if (value <= 0n) throw new Error(`${label} must be positive`);
  return value;
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
  const calldata = asCalldata(env.MERCHANT_MOE_SWAP_CALLDATA, "MERCHANT_MOE_SWAP_CALLDATA");
  return {
    forkRpcUrl: forkRpcUrl(env),
    forkSimulationEnabled: env.MERCHANT_MOE_ENABLE_FORK_SIMULATION === "true",
    mode: parseMode(env, vault),
    router: asAddress(env.MERCHANT_MOE_LB_ROUTER ?? MERCHANT_MOE_MANTLE.lbRouter, "MERCHANT_MOE_LB_ROUTER")!,
    from: asAddress(env.MERCHANT_MOE_SIMULATION_FROM, "MERCHANT_MOE_SIMULATION_FROM"),
    vault,
    calldata,
    calldataSource: calldata ? "env" : "missing",
    recipient: asAddress(env.MERCHANT_MOE_SWAP_RECIPIENT, "MERCHANT_MOE_SWAP_RECIPIENT"),
    deadline: parseOptionalPositiveInteger(env.MERCHANT_MOE_SWAP_DEADLINE, "MERCHANT_MOE_SWAP_DEADLINE"),
    valueWei: parseWei(env.MERCHANT_MOE_SIMULATION_VALUE_WEI, "MERCHANT_MOE_SIMULATION_VALUE_WEI"),
    rationale: env.MERCHANT_MOE_SIMULATION_RATIONALE ?? "Merchant Moe mainnet-fork simulation",
  };
}

function parseReadinessBigint(raw: string | undefined, label: string): bigint {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw);
}

function deadlineSeconds(readiness: MerchantMoeForkReadinessReport): bigint {
  if (!readiness.deadlineSeconds) return DEFAULT_DEADLINE_SECONDS;
  const parsed = parseReadinessBigint(readiness.deadlineSeconds, "deadlineSeconds");
  return parsed > 0n ? parsed : DEFAULT_DEADLINE_SECONDS;
}

function nowUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

function autoRecipient(config: MerchantMoeForkSimulationConfig): `0x${string}` | undefined {
  if (config.recipient) return config.recipient;
  return config.mode === "vault-execute" ? config.vault : config.from;
}

function withAutoCalldata(
  readiness: MerchantMoeForkReadinessReport,
  config: MerchantMoeForkSimulationConfig,
  quote?: MerchantMoeQuote,
): MerchantMoeForkSimulationConfig {
  if (config.calldata || !quote) return config;

  const recipient = autoRecipient(config);
  if (!recipient) return config;

  try {
    const amountIn = parseReadinessBigint(readiness.amountIn, "amountIn");
    const amountOutMin = parseReadinessBigint(readiness.minOutWei, "minOutWei");
    const deadline = config.deadline ?? nowUnixSeconds() + deadlineSeconds(readiness);
    const calldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn,
      amountOutMin,
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient,
      deadline,
    });

    return {
      ...config,
      calldata,
      calldataSource: "auto",
      recipient,
      deadline,
    };
  } catch (error) {
    return {
      ...config,
      calldataSource: "build-error",
      calldataBuildError: errorReason(error),
      recipient,
    };
  }
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
  if (!config.calldata && !config.calldataBuildError) {
    findings.push({
      ruleId: "CALLDATA_MISSING",
      severity: "blocker",
      reason: "Provide MERCHANT_MOE_SWAP_CALLDATA or enough quote/path metadata for the simulation-only LBRouter calldata builder.",
    });
  }
  if (config.calldataBuildError) {
    findings.push({
      ruleId: "CALLDATA_BUILD_FAILED",
      severity: "blocker",
      reason: config.calldataBuildError,
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
    !findings.some((finding) => finding.severity === "blocker" || finding.severity === "critical")
  );
}

function swapOwner(config: MerchantMoeForkSimulationConfig): `0x${string}` | undefined {
  return config.mode === "vault-execute" ? config.vault : config.from;
}

async function readErc20Raw(
  client: ForkSimulationClient,
  token: `0x${string}`,
  functionName: "balanceOf" | "allowance",
  args: readonly `0x${string}`[],
): Promise<bigint> {
  if (!client.readContract) throw new Error("fork client does not support ERC20 readContract preflight");
  return (await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName,
    args,
  })) as bigint;
}

async function buildErc20Preflight(
  client: ForkSimulationClient,
  config: MerchantMoeForkSimulationConfig,
  quote: MerchantMoeQuote,
): Promise<MerchantMoeForkPreflight> {
  const tokenIn = quote.route[0];
  const owner = swapOwner(config);
  if (!tokenIn) throw new Error("Merchant Moe quote route is missing token-in");
  if (!owner) throw new Error("Merchant Moe simulation owner is missing");

  const base = {
    tokenIn,
    owner,
    spender: config.router,
    requiredAmountIn: quote.amountIn.toString(),
    warnings: [] as string[],
  };

  try {
    const [balanceRaw, allowanceRaw] = await Promise.all([
      readErc20Raw(client, tokenIn, "balanceOf", [owner]),
      readErc20Raw(client, tokenIn, "allowance", [owner, config.router]),
    ]);
    const balanceOk = balanceRaw >= quote.amountIn;
    const allowanceOk = allowanceRaw >= quote.amountIn;
    const allowanceStatus = classifyAllowance(allowanceRaw, quote.amountIn);
    const warnings = allowanceStatus === "excessive" || allowanceStatus === "unbounded" ? [`router allowance is ${allowanceStatus}`] : [];
    const status = balanceOk && allowanceOk ? "ok" : "blocked";
    return {
      ...base,
      status,
      balanceRaw: balanceRaw.toString(),
      allowanceRaw: allowanceRaw.toString(),
      allowanceStatus,
      balanceOk,
      allowanceOk,
      warnings,
      reason: status === "ok" ? "token-in balance and router allowance cover amountIn" : "token-in balance or router allowance is insufficient",
    };
  } catch (error) {
    return {
      ...base,
      status: "unchecked",
      warnings: [errorReason(error)],
      reason: `ERC20 preflight failed: ${errorReason(error)}`,
    };
  }
}

function preflightFindings(preflight: MerchantMoeForkPreflight | undefined): MerchantMoeForkSimulationFinding[] {
  if (!preflight) return [];
  const findings: MerchantMoeForkSimulationFinding[] = [];
  if (preflight.status === "unchecked") {
    findings.push({
      ruleId: "ERC20_PREFLIGHT_FAILED",
      severity: "blocker",
      reason: preflight.reason,
    });
    return findings;
  }
  if (preflight.balanceOk === false) {
    findings.push({
      ruleId: "TOKEN_BALANCE_TOO_LOW",
      severity: "blocker",
      reason: `Token-in balance ${preflight.balanceRaw ?? "unknown"} is below required amountIn ${preflight.requiredAmountIn}.`,
    });
  }
  if (preflight.allowanceOk === false) {
    findings.push({
      ruleId: "ROUTER_ALLOWANCE_TOO_LOW",
      severity: "blocker",
      reason: `Router allowance ${preflight.allowanceRaw ?? "unknown"} is below required amountIn ${preflight.requiredAmountIn}.`,
    });
  }
  if (preflight.allowanceStatus === "excessive" || preflight.allowanceStatus === "unbounded") {
    findings.push({
      ruleId: "ROUTER_ALLOWANCE_UNSAFE",
      severity: "warning",
      reason: `Router allowance is ${preflight.allowanceStatus}; prefer bounded approvals before guarded execution.`,
    });
  }
  return findings;
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
    steps.push("Provide quote path metadata, simulation recipient, and minOut/deadline inputs so calldata can be built safely.");
  }
  if (report.findings.some((finding) => finding.ruleId === "CALLDATA_BUILD_FAILED")) {
    steps.push("Fix the calldata builder input error before attempting fork simulation.");
  }
  if (report.findings.some((finding) => finding.ruleId === "SIMULATION_FROM_MISSING")) {
    steps.push("Choose a fork account/vault-like address with the token balances and approvals needed for the swap.");
  }
  if (report.findings.some((finding) => finding.ruleId === "ERC20_PREFLIGHT_FAILED")) {
    steps.push("Fix ERC20 balance/allowance reads on the fork RPC before attempting router simulation.");
  }
  if (report.findings.some((finding) => finding.ruleId === "TOKEN_BALANCE_TOO_LOW")) {
    steps.push("Use or fund a fork simulation owner with enough token-in balance for amountIn.");
  }
  if (report.findings.some((finding) => finding.ruleId === "ROUTER_ALLOWANCE_TOO_LOW")) {
    steps.push("Set a bounded token-in allowance from the simulation owner to the Merchant Moe LBRouter before retrying.");
  }
  if (report.findings.some((finding) => finding.ruleId === "ROUTER_ALLOWANCE_UNSAFE")) {
    steps.push("Prefer a bounded router approval before promoting this path toward guarded execution.");
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
  client?: ForkSimulationClient,
  quote?: MerchantMoeQuote,
): Promise<MerchantMoeForkSimulationReport> {
  const resolvedConfig = withAutoCalldata(readiness, simulationConfig, quote);
  const activeClient = client ?? createForkClient(resolvedConfig);
  const findings = baseFindings(readiness, resolvedConfig);
  let preflight: MerchantMoeForkPreflight | undefined;
  let simulation: SimulationResult | undefined;
  let simulationAttempted = false;

  if (quote && activeClient && resolvedConfig.calldata && swapOwner(resolvedConfig)) {
    preflight = await buildErc20Preflight(activeClient, resolvedConfig, quote);
    findings.push(...preflightFindings(preflight));
  }

  if (canAttempt(resolvedConfig, findings)) {
    simulationAttempted = true;
    simulation =
      resolvedConfig.mode === "vault-execute"
        ? await simulateVaultExecute(activeClient!, resolvedConfig.router, resolvedConfig)
        : await simulateRouterCall(activeClient!, resolvedConfig.router, resolvedConfig);
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
    simulationMode: resolvedConfig.mode,
    executionEnabled: false as const,
    fixtureMode: Boolean(resolvedConfig.fixtureMode),
    forkRpcConfigured: Boolean(resolvedConfig.forkRpcUrl),
    forkSimulationEnabled: resolvedConfig.forkSimulationEnabled,
    simulationAttempted,
    simulationPassed,
    router: resolvedConfig.router,
    from: resolvedConfig.from,
    vault: resolvedConfig.vault,
    target: resolvedConfig.mode === "vault-execute" ? resolvedConfig.vault ?? resolvedConfig.router : resolvedConfig.router,
    calldataSource: resolvedConfig.calldataSource,
    recipient: resolvedConfig.recipient,
    deadline: resolvedConfig.deadline?.toString(),
    valueWei: resolvedConfig.valueWei.toString(),
    calldataBytes: calldataBytes(resolvedConfig.calldata),
    route: readiness.route,
    amountIn: readiness.amountIn,
    expectedOutWei: readiness.expectedOutWei,
    minOutWei: readiness.minOutWei,
    slippageBps: readiness.slippageBps,
    quoteRisk: readiness.quoteRisk,
    preflight,
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
    `fixtureMode: ${report.fixtureMode}`,
    `forkRpcConfigured: ${report.forkRpcConfigured}`,
    `forkSimulationEnabled: ${report.forkSimulationEnabled}`,
    `simulationAttempted: ${report.simulationAttempted}`,
    `simulationPassed: ${report.simulationPassed}`,
    `target: ${report.target}`,
    `from: ${report.from ?? "none"}`,
    `vault: ${report.vault ?? "none"}`,
    `calldataSource: ${report.calldataSource}`,
    `recipient: ${report.recipient ?? "none"}`,
    `deadline: ${report.deadline ?? "none"}`,
    `calldataBytes: ${report.calldataBytes}`,
    `valueWei: ${report.valueWei}`,
    `route: ${report.route.join(" -> ")}`,
    `expectedOutWei: ${report.expectedOutWei}`,
    `minOutWei: ${report.minOutWei}`,
    `slippageBps: ${report.slippageBps}`,
    `preflightStatus: ${report.preflight?.status ?? "not-run"}`,
    `tokenIn: ${report.preflight?.tokenIn ?? "none"}`,
    `preflightOwner: ${report.preflight?.owner ?? "none"}`,
    `tokenInBalanceRaw: ${report.preflight?.balanceRaw ?? "none"}`,
    `routerAllowanceRaw: ${report.preflight?.allowanceRaw ?? "none"}`,
    `routerAllowanceStatus: ${report.preflight?.allowanceStatus ?? "none"}`,
    `preflightReason: ${report.preflight?.reason ?? "none"}`,
    `preflightWarnings: ${report.preflight?.warnings.length ? report.preflight.warnings.join("; ") : "none"}`,
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
  const report = await buildMerchantMoeForkSimulationReport(readiness, simulationConfig, client, quote);
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
