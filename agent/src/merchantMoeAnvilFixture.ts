import "dotenv/config";
import { spawn, type ChildProcess } from "child_process";
import { once } from "events";
import { pathToFileURL } from "url";
import { createPublicClient, encodeFunctionData, http, toHex } from "viem";
import { mantle } from "viem/chains";
import {
  buildMerchantMoeForkSimulationReport,
  formatMerchantMoeForkSimulation,
  loadMerchantMoeForkSimulationConfig,
  type ForkSimulationClient,
  type MerchantMoeForkSimulationReport,
} from "./merchantMoeForkSimulation.js";
import { buildMerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import {
  parseMerchantMoeQuoteSmokeConfig,
  quoteTokenInPerTokenOutPriceWei,
  type MerchantMoeQuoteSmokeConfig,
} from "./merchantMoeQuoteSmoke.js";
import {
  MERCHANT_MOE_MANTLE,
  createMerchantMoeReadOnlyAdapter,
  type MerchantMoeQuote,
} from "./protocols/merchantMoeReadOnlyAdapter.js";
import { MERCHANT_MOE_TOKENS } from "./protocols/merchantMoeRoutePresets.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

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

export interface MerchantMoeAnvilFixtureConfig {
  forkUrl: string;
  anvilBinary: string;
  host: string;
  port: number;
  routePreset: string;
  amountInWei?: string;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: JsonRpcError;
}

interface TransactionReceipt {
  status?: `0x${string}`;
  blockNumber?: `0x${string}`;
}

function requiredForkUrl(env: NodeJS.ProcessEnv): string {
  const value =
    env.MANTLE_MAINNET_FORK_RPC_URL?.trim() ||
    env.MERCHANT_MOE_FORK_RPC_URL?.trim() ||
    env.MANTLE_MAINNET_RPC_URL?.trim() ||
    env.MERCHANT_MOE_RPC_URL?.trim();
  if (!value) {
    throw new Error(
      "Set MANTLE_MAINNET_FORK_RPC_URL, MERCHANT_MOE_FORK_RPC_URL, MANTLE_MAINNET_RPC_URL, or MERCHANT_MOE_RPC_URL.",
    );
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 8_546;
  if (!/^\d+$/.test(raw.trim())) throw new Error("MERCHANT_MOE_ANVIL_PORT must be an integer");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("MERCHANT_MOE_ANVIL_PORT must be between 1024 and 65535");
  }
  return port;
}

export function loadMerchantMoeAnvilFixtureConfig(env = process.env): MerchantMoeAnvilFixtureConfig {
  return {
    forkUrl: requiredForkUrl(env),
    anvilBinary: env.ANVIL_BINARY?.trim() || "anvil",
    host: env.MERCHANT_MOE_ANVIL_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.MERCHANT_MOE_ANVIL_PORT),
    routePreset: env.MERCHANT_MOE_ROUTE_PRESET?.trim() || "wmnt-usdc-direct",
    amountInWei: env.MERCHANT_MOE_AMOUNT_IN_WEI?.trim() || undefined,
  };
}

export function buildMerchantMoeAnvilArgs(config: MerchantMoeAnvilFixtureConfig): string[] {
  return [
    "--fork-url",
    config.forkUrl,
    "--host",
    config.host,
    "--port",
    config.port.toString(),
    "--chain-id",
    MERCHANT_MOE_MANTLE.chainId.toString(),
    "--silent",
  ];
}

function localRpcUrl(config: MerchantMoeAnvilFixtureConfig): string {
  return `http://${config.host}:${config.port}`;
}

async function jsonRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`local Anvil RPC returned HTTP ${response.status}`);
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error) throw new Error(`${body.error.message} (${body.error.code})`);
  if (body.result === undefined) throw new Error(`local Anvil RPC returned no result for ${method}`);
  return body.result;
}

async function waitForAnvil(
  url: string,
  child: ChildProcess,
  logs: () => string,
  spawnError: () => Error | undefined,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const startupError = spawnError();
    if (startupError) {
      throw new Error(`Anvil failed to start: ${startupError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited before readiness (code ${child.exitCode}): ${logs()}`);
    }
    try {
      const chainId = await jsonRpc<`0x${string}`>(url, "eth_chainId");
      if (Number(BigInt(chainId)) !== MERCHANT_MOE_MANTLE.chainId) {
        throw new Error(`Anvil chain ID ${Number(BigInt(chainId))} did not match Mantle ${MERCHANT_MOE_MANTLE.chainId}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Anvil did not become ready: ${(lastError as Error | undefined)?.message ?? logs()}`);
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForReceipt(url: string, hash: `0x${string}`): Promise<TransactionReceipt> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const receipt = await jsonRpc<TransactionReceipt | null>(url, "eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`fork-only setup transaction ${hash} reverted`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for fork-only setup transaction ${hash}`);
}

async function sendUnlockedTransaction(
  url: string,
  transaction: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: `0x${string}`;
  },
): Promise<`0x${string}`> {
  const hash = await jsonRpc<`0x${string}`>(url, "eth_sendTransaction", [transaction]);
  await waitForReceipt(url, hash);
  return hash;
}

async function assertForkContract(url: string, address: `0x${string}`, label: string): Promise<void> {
  const code = await jsonRpc<`0x${string}`>(url, "eth_getCode", [address, "latest"]);
  if (code === "0x") throw new Error(`${label} has no bytecode on the local Mantle fork`);
}

function quoteConfig(
  env: NodeJS.ProcessEnv,
  config: MerchantMoeAnvilFixtureConfig,
): MerchantMoeQuoteSmokeConfig {
  return parseMerchantMoeQuoteSmokeConfig({
    ...env,
    MERCHANT_MOE_ROUTE_PRESET: config.routePreset,
    MERCHANT_MOE_AMOUNT_IN_WEI: config.amountInWei,
    MERCHANT_MOE_REFERENCE_SOURCE: "none",
  });
}

async function appendTrace(
  trace: JsonlTraceWriter,
  report: MerchantMoeForkSimulationReport,
): Promise<void> {
  try {
    await trace.append("merchant_moe.fork_simulation", {
      protocolId: report.protocolId,
      mode: report.mode,
      fixtureMode: report.fixtureMode,
      fixtureKind: report.fixtureKind,
      report,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[merchant-moe] Anvil fixture trace write failed:", e?.message ?? "unknown error");
  }
}

export async function runMerchantMoeAnvilFixture(
  env = process.env,
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env }),
): Promise<MerchantMoeForkSimulationReport> {
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

    const initialQuoteConfig = quoteConfig(env, config);
    const amountIn = initialQuoteConfig.amountIn;
    const depositHash = await sendUnlockedTransaction(url, {
      from: account,
      to: MERCHANT_MOE_TOKENS.WMNT.address,
      data: encodeFunctionData({ abi: WMNT_ABI, functionName: "deposit" }),
      value: toHex(amountIn),
    });
    const approveHash = await sendUnlockedTransaction(url, {
      from: account,
      to: MERCHANT_MOE_TOKENS.WMNT.address,
      data: encodeFunctionData({
        abi: WMNT_ABI,
        functionName: "approve",
        args: [MERCHANT_MOE_MANTLE.lbRouter, amountIn],
      }),
    });

    const client = createPublicClient({
      chain: mantle,
      transport: http(url),
    });
    const forkBlockNumber = await client.getBlockNumber();
    const adapter = createMerchantMoeReadOnlyAdapter(client, {
      chainId: MERCHANT_MOE_MANTLE.chainId,
      lbQuoter: MERCHANT_MOE_MANTLE.lbQuoter,
      lbRouter: MERCHANT_MOE_MANTLE.lbRouter,
      rpcUrl: url,
    });
    const quote: MerchantMoeQuote = await adapter.quoteExactInput(initialQuoteConfig);
    const finalQuoteConfig: MerchantMoeQuoteSmokeConfig = {
      ...initialQuoteConfig,
      referenceSource: "manual",
      referencePriceWei: quoteTokenInPerTokenOutPriceWei(quote, initialQuoteConfig),
    };
    const readinessEnv = {
      ...env,
      MERCHANT_MOE_FORK_RPC_URL: url,
      MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
    };
    const readiness = await buildMerchantMoeForkReadinessReport(quote, finalQuoteConfig, readinessEnv);
    const simulationConfig = {
      ...loadMerchantMoeForkSimulationConfig({
        ...env,
        MERCHANT_MOE_FORK_RPC_URL: url,
        MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
        MERCHANT_MOE_SIMULATION_FROM: account,
        MERCHANT_MOE_LB_ROUTER: MERCHANT_MOE_MANTLE.lbRouter,
        MERCHANT_MOE_SWAP_CALLDATA: "",
        MERCHANT_MOE_SIMULATION_RATIONALE: "Merchant Moe Anvil-backed Mantle mainnet fork fixture",
      }),
      fixtureMode: true,
      fixtureKind: "anvil-mainnet-fork" as const,
      forkBlockNumber,
      setupTransactionHashes: [depositHash, approveHash],
    };
    const report = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig,
      client as ForkSimulationClient,
      quote,
    );
    write(formatMerchantMoeForkSimulation(report));
    await appendTrace(trace, report);
    return report;
  } finally {
    await stopAnvil(child);
  }
}

export async function main(): Promise<void> {
  const report = await runMerchantMoeAnvilFixture();
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] Anvil fixture failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
