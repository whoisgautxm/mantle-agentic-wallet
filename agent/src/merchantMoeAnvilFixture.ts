import "dotenv/config";
import { spawn, type ChildProcess } from "child_process";
import { once } from "events";
import { readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  toEventSelector,
  toHex,
} from "viem";
import { mantle } from "viem/chains";
import {
  buildMerchantMoeForkSimulationReport,
  formatMerchantMoeForkSimulation,
  loadMerchantMoeForkSimulationConfig,
  type ForkSimulationClient,
  type MerchantMoeForkExecutionEvidence,
  type MerchantMoeForkSimulationReport,
  type MerchantMoeVaultEvidence,
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
import { buildMerchantMoeSwapExactTokensForTokensCalldata } from "./protocols/merchantMoeCalldata.js";
import { MERCHANT_MOE_TOKENS } from "./protocols/merchantMoeRoutePresets.js";
import { ERC20_ABI } from "./portfolio/erc20.js";
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

const AGENT_VAULT_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_agent", type: "address" },
      { name: "_spendLimitPerTx", type: "uint256" },
      { name: "_dailyLimit", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAllowedTarget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "rationale", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  { type: "function", name: "agent", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "allowedTarget",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const AGENT_DECISION_TOPIC = toEventSelector("AgentDecision(uint256,address,uint256,bytes,string)");
const DEFAULT_DEADLINE_SECONDS = 1_200n;

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
  contractAddress?: `0x${string}` | null;
  gasUsed?: `0x${string}`;
  logs?: Array<{
    address?: `0x${string}`;
    topics?: `0x${string}`[];
  }>;
}

interface FoundryArtifact {
  bytecode?: {
    object?: string;
  };
}

interface SubmittedTransaction {
  hash: `0x${string}`;
  receipt: TransactionReceipt;
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

function workspaceRoot(cwd = process.cwd()): string {
  return path.basename(cwd) === "agent" ? path.dirname(cwd) : cwd;
}

async function runProcess(binary: string, args: string[], cwd: string, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-4_000);
    });
    child.on("error", (error) => reject(new Error(`${label} failed to start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}: ${output.trim()}`));
    });
  });
}

export function parseAgentVaultBytecode(raw: string): `0x${string}` {
  const artifact = JSON.parse(raw) as FoundryArtifact;
  const object = artifact.bytecode?.object?.trim();
  if (!object) throw new Error("AgentVault artifact is missing bytecode.object");
  const bytecode = object.startsWith("0x") ? object : `0x${object}`;
  if (!/^0x[a-fA-F0-9]+$/.test(bytecode)) throw new Error("AgentVault artifact bytecode is not valid hex");
  return bytecode as `0x${string}`;
}

async function loadAgentVaultBytecode(env: NodeJS.ProcessEnv): Promise<`0x${string}`> {
  const root = workspaceRoot();
  const contractsDirectory = env.CONTRACTS_DIRECTORY?.trim() || path.join(root, "contracts");
  const forgeBinary = env.FORGE_BINARY?.trim() || "forge";
  await runProcess(forgeBinary, ["build", "--silent"], contractsDirectory, "forge build");
  const artifactPath =
    env.AGENT_VAULT_ARTIFACT_PATH?.trim() ||
    path.join(contractsDirectory, "out", "AgentVault.sol", "AgentVault.json");
  return parseAgentVaultBytecode(await readFile(artifactPath, "utf8"));
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

async function submitUnlockedTransaction(
  url: string,
  transaction: {
    from: `0x${string}`;
    to?: `0x${string}`;
    data?: `0x${string}`;
    value?: `0x${string}`;
  },
): Promise<SubmittedTransaction> {
  const hash = await jsonRpc<`0x${string}`>(url, "eth_sendTransaction", [transaction]);
  const receipt = await waitForReceipt(url, hash);
  return { hash, receipt };
}

async function sendUnlockedTransaction(
  url: string,
  transaction: {
    from: `0x${string}`;
    to?: `0x${string}`;
    data?: `0x${string}`;
    value?: `0x${string}`;
  },
): Promise<`0x${string}`> {
  return (await submitUnlockedTransaction(url, transaction)).hash;
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

export function agentVaultLimits(amountIn: bigint): { spendLimitPerTx: bigint; dailyLimit: bigint } {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  return {
    spendLimitPerTx: amountIn,
    dailyLimit: amountIn * 2n,
  };
}

async function deployAgentVault(
  url: string,
  account: `0x${string}`,
  bytecode: `0x${string}`,
  amountIn: bigint,
): Promise<{ address: `0x${string}`; hash: `0x${string}` }> {
  const limits = agentVaultLimits(amountIn);
  const deployment = await submitUnlockedTransaction(url, {
    from: account,
    data: encodeDeployData({
      abi: AGENT_VAULT_ABI,
      bytecode,
      args: [account, limits.spendLimitPerTx, limits.dailyLimit],
    }),
  });
  const address = deployment.receipt.contractAddress;
  if (!address) throw new Error("AgentVault deployment receipt did not include a contract address");
  return { address, hash: deployment.hash };
}

async function setVaultTarget(
  url: string,
  owner: `0x${string}`,
  vault: `0x${string}`,
  target: `0x${string}`,
): Promise<`0x${string}`> {
  return sendUnlockedTransaction(url, {
    from: owner,
    to: vault,
    data: encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: "setAllowedTarget",
      args: [target, true],
    }),
  });
}

async function executeThroughVault(
  url: string,
  agent: `0x${string}`,
  vault: `0x${string}`,
  target: `0x${string}`,
  value: bigint,
  data: `0x${string}`,
  rationale: string,
): Promise<SubmittedTransaction> {
  return submitUnlockedTransaction(url, {
    from: agent,
    to: vault,
    data: encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: "execute",
      args: [target, value, data, rationale],
    }),
  });
}

async function readVaultEvidence(
  client: ReturnType<typeof createPublicClient>,
  vault: `0x${string}`,
  token: `0x${string}`,
  router: `0x${string}`,
): Promise<MerchantMoeVaultEvidence> {
  const [agent, paused, tokenAllowed, routerAllowed, spendLimitPerTx, dailyLimit, spentToday, nonce] =
    await Promise.all([
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "agent" }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "paused" }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "allowedTarget", args: [token] }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "allowedTarget", args: [router] }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "spendLimitPerTx" }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "dailyLimit" }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "spentToday" }),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "nonce" }),
    ]);
  return {
    address: vault,
    agent: agent as `0x${string}`,
    paused: paused as boolean,
    tokenAllowed: tokenAllowed as boolean,
    routerAllowed: routerAllowed as boolean,
    spendLimitPerTx: (spendLimitPerTx as bigint).toString(),
    dailyLimit: (dailyLimit as bigint).toString(),
    spentToday: (spentToday as bigint).toString(),
    nonceBeforeSwap: (nonce as bigint).toString(),
  };
}

async function readTokenBalance(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

async function executeForkSwap(
  url: string,
  client: ReturnType<typeof createPublicClient>,
  account: `0x${string}`,
  vault: `0x${string}`,
  router: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  minOut: bigint,
  calldata: `0x${string}`,
): Promise<MerchantMoeForkExecutionEvidence> {
  const [tokenInBefore, tokenOutBefore, nonceBefore] = await Promise.all([
    readTokenBalance(client, tokenIn, vault),
    readTokenBalance(client, tokenOut, vault),
    client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "nonce" }) as Promise<bigint>,
  ]);
  try {
    const transaction = await executeThroughVault(
      url,
      account,
      vault,
      router,
      0n,
      calldata,
      "Merchant Moe fork-only guarded swap",
    );
    const [tokenInAfter, tokenOutAfter, nonceAfter] = await Promise.all([
      readTokenBalance(client, tokenIn, vault),
      readTokenBalance(client, tokenOut, vault),
      client.readContract({ address: vault, abi: AGENT_VAULT_ABI, functionName: "nonce" }) as Promise<bigint>,
    ]);
    const tokenOutDelta = tokenOutAfter - tokenOutBefore;
    const agentDecisionEvents = (transaction.receipt.logs ?? []).filter(
      (log) =>
        log.address?.toLowerCase() === vault.toLowerCase() &&
        log.topics?.[0]?.toLowerCase() === AGENT_DECISION_TOPIC.toLowerCase(),
    ).length;
    const passed =
      tokenInAfter < tokenInBefore &&
      tokenOutDelta >= minOut &&
      nonceAfter === nonceBefore + 1n &&
      agentDecisionEvents === 1;
    return {
      attempted: true,
      passed,
      transactionHash: transaction.hash,
      gasUsed: transaction.receipt.gasUsed ? BigInt(transaction.receipt.gasUsed).toString() : undefined,
      agentDecisionEvents,
      tokenInBefore: tokenInBefore.toString(),
      tokenInAfter: tokenInAfter.toString(),
      tokenOutBefore: tokenOutBefore.toString(),
      tokenOutAfter: tokenOutAfter.toString(),
      tokenOutDelta: tokenOutDelta.toString(),
      nonceBefore: nonceBefore.toString(),
      nonceAfter: nonceAfter.toString(),
      reason: passed
        ? "fork-only AgentVault.execute swap changed balances, met minOut, and emitted one AgentDecision"
        : "fork-only swap receipt did not satisfy balance, minOut, nonce, or AgentDecision assertions",
    };
  } catch (error) {
    const e = error as any;
    return {
      attempted: true,
      passed: false,
      agentDecisionEvents: 0,
      tokenInBefore: tokenInBefore.toString(),
      tokenOutBefore: tokenOutBefore.toString(),
      nonceBefore: nonceBefore.toString(),
      reason: e?.shortMessage ?? e?.message ?? "fork-only vault execution failed",
    };
  }
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
    const bytecode = await loadAgentVaultBytecode(env);
    const deployment = await deployAgentVault(url, account, bytecode, amountIn);
    const tokenAllowHash = await setVaultTarget(
      url,
      account,
      deployment.address,
      MERCHANT_MOE_TOKENS.WMNT.address,
    );
    const routerAllowHash = await setVaultTarget(
      url,
      account,
      deployment.address,
      MERCHANT_MOE_MANTLE.lbRouter,
    );
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
      "Wrap fork-only MNT for Merchant Moe",
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
        args: [MERCHANT_MOE_MANTLE.lbRouter, amountIn],
      }),
      "Approve bounded WMNT amount for Merchant Moe",
    );

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
    const deadline =
      BigInt(Math.floor(Date.now() / 1_000)) +
      (readiness.deadlineSeconds ? BigInt(readiness.deadlineSeconds) : DEFAULT_DEADLINE_SECONDS);
    const swapCalldata = buildMerchantMoeSwapExactTokensForTokensCalldata({
      amountIn,
      amountOutMin: BigInt(readiness.minOutWei),
      tokenPath: quote.route,
      pairBinSteps: quote.binSteps,
      versions: quote.versions,
      recipient: deployment.address,
      deadline,
    });
    const vaultEvidence = await readVaultEvidence(
      client,
      deployment.address,
      MERCHANT_MOE_TOKENS.WMNT.address,
      MERCHANT_MOE_MANTLE.lbRouter,
    );
    const simulationConfig = {
      ...loadMerchantMoeForkSimulationConfig({
        ...env,
        MERCHANT_MOE_FORK_RPC_URL: url,
        MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
        MERCHANT_MOE_SIMULATION_FROM: account,
        MERCHANT_MOE_SIMULATION_MODE: "vault-execute",
        MERCHANT_MOE_SIMULATION_VAULT: deployment.address,
        MERCHANT_MOE_LB_ROUTER: MERCHANT_MOE_MANTLE.lbRouter,
        MERCHANT_MOE_SWAP_CALLDATA: "",
        MERCHANT_MOE_SIMULATION_RATIONALE: "Merchant Moe Anvil-backed Mantle mainnet fork fixture",
      }),
      fixtureMode: true,
      fixtureKind: "anvil-mainnet-fork" as const,
      forkBlockNumber,
      mode: "vault-execute" as const,
      vault: deployment.address,
      calldata: swapCalldata,
      calldataSource: "auto" as const,
      recipient: deployment.address,
      deadline,
      setupTransactionHashes: [
        deployment.hash,
        tokenAllowHash,
        routerAllowHash,
        fundingHash,
        wrapTransaction.hash,
        approvalTransaction.hash,
      ],
    };
    const simulationReport = await buildMerchantMoeForkSimulationReport(
      readiness,
      simulationConfig,
      client as ForkSimulationClient,
      quote,
    );
    const tokenOut = quote.route.at(-1);
    if (!tokenOut) throw new Error("Merchant Moe quote route is missing token-out");
    const forkExecution = simulationReport.ok
      ? await executeForkSwap(
          url,
          client,
          account,
          deployment.address,
          MERCHANT_MOE_MANTLE.lbRouter,
          quote.route[0],
          tokenOut,
          BigInt(readiness.minOutWei),
          swapCalldata,
        )
      : {
          attempted: false,
          passed: false,
          agentDecisionEvents: 0,
          reason: "fork execution skipped because simulation gate did not pass",
        };
    const executionFinding = forkExecution.passed
      ? []
      : [{
          ruleId: "FORK_EXECUTION_FAILED" as const,
          severity: "blocker" as const,
          reason: forkExecution.reason ?? "fork-only AgentVault execution failed",
        }];
    const report: MerchantMoeForkSimulationReport = {
      ...simulationReport,
      ok: simulationReport.ok && forkExecution.passed,
      vaultEvidence,
      forkExecution,
      findings: [...simulationReport.findings, ...executionFinding],
      nextSteps: forkExecution.passed
        ? [
            "Keep this AgentVault-to-Merchant-Moe path as the canonical fork regression fixture.",
            "Add adverse fork cases for paused vault, disallowed router, stale oracle, slippage, and unsafe allowance.",
            "Keep live execution disabled until the adversarial suite and submission review pass.",
          ]
        : [
            "Fix the fork-only AgentVault execution evidence before considering any live protocol path.",
            ...simulationReport.nextSteps,
          ],
    };
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
