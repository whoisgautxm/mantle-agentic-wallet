import "dotenv/config";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  toHex,
} from "viem";
import { mantle } from "viem/chains";
import {
  assertForkContract,
  buildMerchantMoeAnvilArgs,
  deployAgentVault,
  executeThroughVault,
  jsonRpc,
  loadAgentVaultBytecode,
  loadMerchantMoeAnvilFixtureConfig,
  localRpcUrl,
  quoteConfig,
  sendUnlockedTransaction,
  setVaultPaused,
  setVaultTarget,
  stopAnvil,
  waitForAnvil,
} from "./merchantMoeAnvilFixture.js";
import {
  buildMerchantMoeForkSimulationReport,
  loadMerchantMoeForkSimulationConfig,
  type ForkSimulationClient,
  type MerchantMoeForkSimulationReport,
} from "./merchantMoeForkSimulation.js";
import { buildMerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import { quoteTokenInPerTokenOutPriceWei } from "./merchantMoeQuoteSmoke.js";
import {
  MERCHANT_MOE_MANTLE,
  createMerchantMoeReadOnlyAdapter,
  type MerchantMoeQuote,
} from "./protocols/merchantMoeReadOnlyAdapter.js";
import { buildMerchantMoeSwapExactTokensForTokensCalldata } from "./protocols/merchantMoeCalldata.js";
import { MERCHANT_MOE_TOKENS } from "./protocols/merchantMoeRoutePresets.js";
import { evaluateRisk } from "./risk/engine.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_DEADLINE_SECONDS = 1_200n;

const WMNT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type MerchantMoeAdversarialScenarioId =
  | "paused-vault"
  | "disallowed-router"
  | "stale-oracle"
  | "min-out-revert"
  | "unsafe-allowance";

export interface MerchantMoeAdversarialScenario {
  id: MerchantMoeAdversarialScenarioId;
  label: string;
  stage: "risk" | "preflight" | "simulation";
  expectedRuleId: string;
  observedRuleId: string;
  passed: boolean;
  simulationAttempted: boolean;
  swapTransactionSubmitted: false;
  reason: string;
  vault?: `0x${string}`;
  setupTransactionHashes: `0x${string}`[];
}

export interface MerchantMoeAdversarialSuiteReport {
  ok: boolean;
  protocolId: "merchant-moe";
  mode: "mainnet-fork-adversarial-suite";
  fixtureKind: "anvil-mainnet-fork";
  executionEnabled: false;
  forkBlockNumber: string;
  route: `0x${string}`[];
  amountIn: string;
  expectedOutWei: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  noUnsafeSwapTransactionsSubmitted: boolean;
  scenarios: MerchantMoeAdversarialScenario[];
  nextSteps: string[];
}

interface PreparedVault {
  address: `0x${string}`;
  setupTransactionHashes: `0x${string}`[];
}

interface ScenarioAssessment {
  id: MerchantMoeAdversarialScenarioId;
  label: string;
  stage: MerchantMoeAdversarialScenario["stage"];
  expectedRuleId: string;
  report: MerchantMoeForkSimulationReport;
  simulationAttempted: boolean;
  reasonIncludes?: string;
  vault: `0x${string}`;
  setupTransactionHashes: `0x${string}`[];
}

async function prepareVault(
  url: string,
  account: `0x${string}`,
  bytecode: `0x${string}`,
  amountIn: bigint,
  approvalAmount = amountIn,
): Promise<PreparedVault> {
  const deployment = await deployAgentVault(url, account, bytecode, amountIn);
  const tokenAllowHash = await setVaultTarget(url, account, deployment.address, MERCHANT_MOE_TOKENS.WMNT.address);
  const routerAllowHash = await setVaultTarget(url, account, deployment.address, MERCHANT_MOE_MANTLE.lbRouter);
  const fundingHash = await sendUnlockedTransaction(url, {
    from: account,
    to: deployment.address,
    value: toHex(amountIn),
  });
  const wrapTransaction = await executeThroughVault(
    url,
    account,
    deployment.address,
    MERCHANT_MOE_TOKENS.WMNT.address,
    amountIn,
    encodeFunctionData({ abi: WMNT_ABI, functionName: "deposit" }),
    "Adversarial fixture: wrap fork-only MNT",
  );
  const approvalTransaction = await executeThroughVault(
    url,
    account,
    deployment.address,
    MERCHANT_MOE_TOKENS.WMNT.address,
    0n,
    encodeFunctionData({
      abi: WMNT_ABI,
      functionName: "approve",
      args: [MERCHANT_MOE_MANTLE.lbRouter, approvalAmount],
    }),
    approvalAmount === amountIn
      ? "Adversarial fixture: bounded Merchant Moe approval"
      : "Adversarial fixture: intentionally unsafe Merchant Moe approval",
  );
  return {
    address: deployment.address,
    setupTransactionHashes: [
      deployment.hash,
      tokenAllowHash,
      routerAllowHash,
      fundingHash,
      wrapTransaction.hash,
      approvalTransaction.hash,
    ],
  };
}

function simulationConfig(
  env: NodeJS.ProcessEnv,
  url: string,
  account: `0x${string}`,
  vault: PreparedVault,
  forkBlockNumber: bigint,
  calldata: `0x${string}`,
  deadline: bigint,
) {
  return {
    ...loadMerchantMoeForkSimulationConfig({
      ...env,
      MERCHANT_MOE_FORK_RPC_URL: url,
      MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
      MERCHANT_MOE_SIMULATION_FROM: account,
      MERCHANT_MOE_SIMULATION_MODE: "vault-execute",
      MERCHANT_MOE_SIMULATION_VAULT: vault.address,
      MERCHANT_MOE_LB_ROUTER: MERCHANT_MOE_MANTLE.lbRouter,
      MERCHANT_MOE_SWAP_CALLDATA: "",
      MERCHANT_MOE_SIMULATION_RATIONALE: "Merchant Moe adversarial Mantle-fork fixture",
    }),
    fixtureMode: true,
    fixtureKind: "anvil-mainnet-fork" as const,
    forkBlockNumber,
    mode: "vault-execute" as const,
    vault: vault.address,
    calldata,
    calldataSource: "auto" as const,
    recipient: vault.address,
    deadline,
    setupTransactionHashes: vault.setupTransactionHashes,
  };
}

export function assessSimulationScenario(input: ScenarioAssessment): MerchantMoeAdversarialScenario {
  const finding = input.report.findings.find((entry) => entry.ruleId === input.expectedRuleId);
  const reason = finding?.reason ?? input.report.simulation?.revertReason ?? input.report.simulation?.reason ?? "expected blocker missing";
  const reasonMatches = input.reasonIncludes ? reason.toLowerCase().includes(input.reasonIncludes.toLowerCase()) : true;
  return {
    id: input.id,
    label: input.label,
    stage: input.stage,
    expectedRuleId: input.expectedRuleId,
    observedRuleId: finding?.ruleId ?? "NONE",
    passed:
      !input.report.ok &&
      Boolean(finding) &&
      input.report.simulationAttempted === input.simulationAttempted &&
      reasonMatches,
    simulationAttempted: input.report.simulationAttempted,
    swapTransactionSubmitted: false,
    reason,
    vault: input.vault,
    setupTransactionHashes: input.setupTransactionHashes,
  };
}

function staleOracleScenario(
  quote: MerchantMoeQuote,
  quotePriceWei: bigint,
  calldata: `0x${string}`,
  vault: PreparedVault,
): MerchantMoeAdversarialScenario {
  const selector = calldata.slice(0, 10) as `0x${string}`;
  const result = evaluateRisk({
    decision: {
      kind: "execute",
      target: MERCHANT_MOE_MANTLE.lbRouter,
      valueWei: 0n,
      calldata,
      action: "buy",
      rationale: "Adversarial fixture: stale oracle must block Merchant Moe execution",
    },
    state: {
      balanceWei: 0n,
      spendLimitPerTx: quote.amountIn,
      dailyLimit: quote.amountIn * 2n,
      spentToday: 0n,
      windowStart: BigInt(Math.floor(Date.now() / 1_000)),
      paused: false,
      tokenBalanceWei: quote.amountIn,
      priceWei: quotePriceWei,
    },
    allowedTargets: [MERCHANT_MOE_MANTLE.lbRouter],
    allowedSelectors: [selector],
    oracle: {
      pair: "WMNT/USDC",
      priceWei: quotePriceWei,
      source: "pyth",
      updatedAt: 1n,
      stale: true,
      maxAgeSeconds: 60n,
    },
    quotePriceWei,
  });
  const observedRuleId = result.ok ? "NONE" : result.ruleId;
  return {
    id: "stale-oracle",
    label: "Stale oracle",
    stage: "risk",
    expectedRuleId: "ORACLE_STALE",
    observedRuleId,
    passed: !result.ok && result.ruleId === "ORACLE_STALE",
    simulationAttempted: false,
    swapTransactionSubmitted: false,
    reason: result.ok ? "risk engine unexpectedly allowed a stale oracle" : result.reason,
    vault: vault.address,
    setupTransactionHashes: vault.setupTransactionHashes,
  };
}

export function summarizeMerchantMoeAdversarialSuite(
  forkBlockNumber: bigint,
  quote: MerchantMoeQuote,
  scenarios: MerchantMoeAdversarialScenario[],
): MerchantMoeAdversarialSuiteReport {
  const passedScenarios = scenarios.filter((scenario) => scenario.passed).length;
  const noUnsafeSwapTransactionsSubmitted = scenarios.every((scenario) => !scenario.swapTransactionSubmitted);
  return {
    ok: passedScenarios === scenarios.length && noUnsafeSwapTransactionsSubmitted,
    protocolId: "merchant-moe",
    mode: "mainnet-fork-adversarial-suite",
    fixtureKind: "anvil-mainnet-fork",
    executionEnabled: false,
    forkBlockNumber: forkBlockNumber.toString(),
    route: quote.route,
    amountIn: quote.amountIn.toString(),
    expectedOutWei: quote.amountOut.toString(),
    totalScenarios: scenarios.length,
    passedScenarios,
    failedScenarios: scenarios.length - passedScenarios,
    noUnsafeSwapTransactionsSubmitted,
    scenarios,
    nextSteps: [
      "Keep this suite alongside the successful vault-fork path as a release gate.",
      "Add allowance revocation and deadline-expiry cases if guarded live execution is ever enabled.",
      "Keep Mantle mainnet transaction submission disabled for the hackathon demo.",
    ],
  };
}

export function formatMerchantMoeAdversarialSuite(report: MerchantMoeAdversarialSuiteReport): string {
  return [
    "[merchant-moe] mainnet-fork adversarial suite",
    `ok: ${report.ok}`,
    `forkBlockNumber: ${report.forkBlockNumber}`,
    `scenarios: ${report.passedScenarios}/${report.totalScenarios} passed`,
    `noUnsafeSwapTransactionsSubmitted: ${report.noUnsafeSwapTransactionsSubmitted}`,
    ...report.scenarios.map(
      (scenario) =>
        `- ${scenario.id}: ${scenario.passed ? "PASS" : "FAIL"} (${scenario.observedRuleId}, simulationAttempted=${scenario.simulationAttempted}) ${scenario.reason}`,
    ),
    "execution: disabled on Mantle mainnet; all fixture state is discarded when Anvil stops",
  ].join("\n");
}

async function appendTrace(trace: JsonlTraceWriter, report: MerchantMoeAdversarialSuiteReport): Promise<void> {
  try {
    await trace.append("merchant_moe.adversarial_suite", {
      protocolId: report.protocolId,
      mode: report.mode,
      report,
    });
  } catch (error) {
    const e = error as Error;
    console.warn("[merchant-moe] adversarial suite trace write failed:", e.message);
  }
}

export async function runMerchantMoeAdversarialFixture(
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
): Promise<MerchantMoeAdversarialSuiteReport> {
  const config = loadMerchantMoeAnvilFixtureConfig(env);
  const url = localRpcUrl(config);
  let output = "";
  let startupError: Error | undefined;
  const child = spawn(config.anvilBinary, buildMerchantMoeAnvilArgs(config), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => {
    startupError = error;
  });
  child.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  });
  child.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  });

  try {
    await waitForAnvil(url, child, () => output.trim(), () => startupError);
    await Promise.all([
      assertForkContract(url, MERCHANT_MOE_TOKENS.WMNT.address, "WMNT"),
      assertForkContract(url, MERCHANT_MOE_MANTLE.lbQuoter, "Merchant Moe LBQuoter"),
      assertForkContract(url, MERCHANT_MOE_MANTLE.lbRouter, "Merchant Moe LBRouter"),
    ]);
    const accounts = await jsonRpc<`0x${string}`[]>(url, "eth_accounts");
    const account = accounts[0];
    if (!account) throw new Error("Anvil exposed no unlocked fixture account");

    const client = createPublicClient({ chain: mantle, transport: http(url) });
    const forkBlockNumber = await client.getBlockNumber();
    const adapter = createMerchantMoeReadOnlyAdapter(client, {
      chainId: MERCHANT_MOE_MANTLE.chainId,
      lbQuoter: MERCHANT_MOE_MANTLE.lbQuoter,
      lbRouter: MERCHANT_MOE_MANTLE.lbRouter,
      rpcUrl: url,
    });
    const initialQuoteConfig = quoteConfig(env, config);
    const quote = await adapter.quoteExactInput(initialQuoteConfig);
    const finalQuoteConfig = {
      ...initialQuoteConfig,
      referenceSource: "manual" as const,
      referencePriceWei: quoteTokenInPerTokenOutPriceWei(quote, initialQuoteConfig),
    };
    const readiness = await buildMerchantMoeForkReadinessReport(quote, finalQuoteConfig, {
      ...env,
      MERCHANT_MOE_FORK_RPC_URL: url,
      MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
    });
    const deadline =
      BigInt(Math.floor(Date.now() / 1_000)) +
      (readiness.deadlineSeconds ? BigInt(readiness.deadlineSeconds) : DEFAULT_DEADLINE_SECONDS);
    const bytecode = await loadAgentVaultBytecode(env);
    const clientForSimulation = client as ForkSimulationClient;
    const scenarios: MerchantMoeAdversarialScenario[] = [];

    const pausedVault = await prepareVault(url, account, bytecode, quote.amountIn);
    pausedVault.setupTransactionHashes.push(await setVaultPaused(url, account, pausedVault.address, true));
    const pausedCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: quote.amountIn,
      amountOutMin: BigInt(readiness.minOutWei),
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: pausedVault.address,
      deadline,
    });
    const pausedReport = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig(env, url, account, pausedVault, forkBlockNumber, pausedCalldata, deadline),
      clientForSimulation,
      quote,
    );
    scenarios.push(
      assessSimulationScenario({
        id: "paused-vault",
        label: "Paused vault",
        stage: "simulation",
        expectedRuleId: "SIMULATION_FAILED",
        report: pausedReport,
        simulationAttempted: true,
        reasonIncludes: "paused",
        vault: pausedVault.address,
        setupTransactionHashes: pausedVault.setupTransactionHashes,
      }),
    );

    const disallowedVault = await prepareVault(url, account, bytecode, quote.amountIn);
    disallowedVault.setupTransactionHashes.push(
      await setVaultTarget(url, account, disallowedVault.address, MERCHANT_MOE_MANTLE.lbRouter, false),
    );
    const disallowedCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: quote.amountIn,
      amountOutMin: BigInt(readiness.minOutWei),
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: disallowedVault.address,
      deadline,
    });
    const disallowedReport = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig(env, url, account, disallowedVault, forkBlockNumber, disallowedCalldata, deadline),
      clientForSimulation,
      quote,
    );
    scenarios.push(
      assessSimulationScenario({
        id: "disallowed-router",
        label: "Disallowed router",
        stage: "simulation",
        expectedRuleId: "SIMULATION_FAILED",
        report: disallowedReport,
        simulationAttempted: true,
        reasonIncludes: "target not allowed",
        vault: disallowedVault.address,
        setupTransactionHashes: disallowedVault.setupTransactionHashes,
      }),
    );

    const staleVault = await prepareVault(url, account, bytecode, quote.amountIn);
    const staleCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: quote.amountIn,
      amountOutMin: BigInt(readiness.minOutWei),
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: staleVault.address,
      deadline,
    });
    scenarios.push(
      staleOracleScenario(
        quote,
        quoteTokenInPerTokenOutPriceWei(quote, initialQuoteConfig),
        staleCalldata,
        staleVault,
      ),
    );

    const slippageVault = await prepareVault(url, account, bytecode, quote.amountIn);
    const impossibleMinOut = quote.amountOut + 1n;
    const slippageCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: quote.amountIn,
      amountOutMin: impossibleMinOut,
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: slippageVault.address,
      deadline,
    });
    const slippageReport = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig(env, url, account, slippageVault, forkBlockNumber, slippageCalldata, deadline),
      clientForSimulation,
      quote,
    );
    scenarios.push(
      assessSimulationScenario({
        id: "min-out-revert",
        label: "Impossible minimum output",
        stage: "simulation",
        expectedRuleId: "SIMULATION_FAILED",
        report: slippageReport,
        simulationAttempted: true,
        vault: slippageVault.address,
        setupTransactionHashes: slippageVault.setupTransactionHashes,
      }),
    );

    const unsafeAllowanceVault = await prepareVault(url, account, bytecode, quote.amountIn, MAX_UINT256);
    const unsafeAllowanceCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn: quote.amountIn,
      amountOutMin: BigInt(readiness.minOutWei),
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: unsafeAllowanceVault.address,
      deadline,
    });
    const unsafeAllowanceReport = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig(
        env,
        url,
        account,
        unsafeAllowanceVault,
        forkBlockNumber,
        unsafeAllowanceCalldata,
        deadline,
      ),
      clientForSimulation,
      quote,
    );
    scenarios.push(
      assessSimulationScenario({
        id: "unsafe-allowance",
        label: "Unbounded router allowance",
        stage: "preflight",
        expectedRuleId: "ROUTER_ALLOWANCE_UNSAFE",
        report: unsafeAllowanceReport,
        simulationAttempted: false,
        vault: unsafeAllowanceVault.address,
        setupTransactionHashes: unsafeAllowanceVault.setupTransactionHashes,
      }),
    );

    const report = summarizeMerchantMoeAdversarialSuite(forkBlockNumber, quote, scenarios);
    write(formatMerchantMoeAdversarialSuite(report));
    await appendTrace(trace, report);
    return report;
  } finally {
    await stopAnvil(child);
  }
}

export async function main(): Promise<void> {
  const report = await runMerchantMoeAdversarialFixture();
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] adversarial fixture failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
