import { publicClient, walletClient, aiVaultAddress, dexAddress, mockTokenAddress } from "./config.js";
import { DEX_ABI, ERC20_ABI } from "./dex.js";
import { assertSimulationSucceeded, simulateExecute, type ExecuteSimulationClient } from "./simulation/simulator.js";
import type { Decision, VaultState } from "./types.js";
import { buildVaultExecutionCall, VAULT_ABI } from "./vault.js";
import type { SimulationResult } from "./simulation/types.js";

export { VAULT_ABI };

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;
type AgentWalletClient = typeof walletClient;

interface ExecuteReceipt {
  status: "success" | "reverted";
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

export interface SubmitExecuteOptions {
  account?: `0x${string}`;
  simulation?: SimulationResult;
  simulator?: typeof simulateExecute;
  simulationClient?: ExecuteSimulationClient;
  waitForTransactionReceipt?: (hash: `0x${string}`) => Promise<ExecuteReceipt>;
}

export interface ExecuteResult {
  hash: `0x${string}`;
  gasUsedWei: bigint;
  gasCostWei: bigint; // gasUsed * effectiveGasPrice, paid by the runner EOA (not the vault)
}

/// Error thrown when a guarded execute reverts on-chain; carries the hash + realized gas so the
/// caller can record a complete `reverted` terminal trace event (see live-run report sections 6, 11).
export class ExecuteRevertedError extends Error {
  constructor(
    readonly hash: `0x${string}`,
    readonly gasUsedWei: bigint,
    readonly gasCostWei: bigint,
  ) {
    super(`execute tx reverted on-chain: ${hash}`);
    this.name = "ExecuteRevertedError";
  }
}

const READ_RETRY_DELAY_MS = 2500;
const READ_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(error: unknown): boolean {
  const e = error as any;
  const text = [
    e?.details,
    e?.shortMessage,
    e?.message,
    e?.cause?.details,
    e?.cause?.shortMessage,
    e?.cause?.message,
    e?.cause?.cause?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("rate limit");
}

async function retryRead<T>(label: string, read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === READ_RETRIES) break;
      const delay = READ_RETRY_DELAY_MS * (attempt + 1);
      console.warn(`[rpc] ${label} rate-limited; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

export async function getGasPriceWei(): Promise<bigint> {
  return retryRead("gasPrice", () => publicClient.getGasPrice());
}

export async function getHeadBlock(): Promise<bigint> {
  return retryRead("headBlock", () => publicClient.getBlockNumber());
}

export async function readPrice(blockNumber?: bigint): Promise<bigint> {
  return retryRead(
    "price",
    async () =>
      (await publicClient.readContract({
        address: dexAddress,
        abi: DEX_ABI,
        functionName: "price",
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      })) as bigint,
  );
}

/// Atomic observation: every field is read at a single pinned block so price history, balances,
/// limits, token inventory, and DEX price can never come from different blocks (see live-run
/// report section 9: the 369 bps split-snapshot bug). Pass `pinnedBlock` to align across vaults.
export async function readVaultState(
  vault: `0x${string}` = aiVaultAddress,
  pinnedBlock?: bigint,
): Promise<VaultState> {
  const blockNumber = pinnedBlock ?? (await retryRead("blockNumber", () => publicClient.getBlockNumber()));
  const at = { blockNumber } as const;
  const balanceWei = await retryRead("vault balance", () => publicClient.getBalance({ address: vault, ...at }));
  const spendLimitPerTx = await retryRead("spendLimitPerTx", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spendLimitPerTx", ...at }),
  );
  const dailyLimit = await retryRead("dailyLimit", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "dailyLimit", ...at }),
  );
  const spentToday = await retryRead("spentToday", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentToday", ...at }),
  );
  const windowStart = await retryRead("windowStart", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "windowStart", ...at }),
  );
  const paused = await retryRead("paused", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused", ...at }),
  );
  const tokenBalanceWei = await retryRead("tokenBalance", () =>
    publicClient.readContract({ address: mockTokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [vault], ...at }),
  );
  const priceWei = await readPrice(blockNumber);

  return {
    balanceWei,
    spendLimitPerTx: spendLimitPerTx as bigint,
    dailyLimit: dailyLimit as bigint,
    spentToday: spentToday as bigint,
    windowStart: windowStart as bigint,
    paused: paused as boolean,
    tokenBalanceWei: tokenBalanceWei as bigint,
    priceWei: priceWei as bigint,
    blockNumber,
  };
}

export async function submitExecute(
  vault: `0x${string}`,
  d: ExecuteDecision,
  client: AgentWalletClient = walletClient,
  options: SubmitExecuteOptions = {},
): Promise<ExecuteResult> {
  const account = options.account ?? ((client as any).account?.address as `0x${string}` | undefined);
  const preflight =
    options.simulation ??
    (await (options.simulator ?? simulateExecute)(vault, d, account ?? failMissingSimulationAccount(), {
      client: options.simulationClient,
    }));

  assertSimulationSucceeded(preflight);

  const execution = buildVaultExecutionCall(d);
  const hash = await client.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: execution.functionName,
    args: execution.args,
  });
  const waitForTransactionReceipt =
    options.waitForTransactionReceipt ?? ((txHash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash: txHash }));
  const receipt = await waitForTransactionReceipt(hash);
  const gasUsedWei = receipt.gasUsed ?? 0n;
  const gasCostWei = gasUsedWei * (receipt.effectiveGasPrice ?? 0n);
  if (receipt.status !== "success") {
    throw new ExecuteRevertedError(hash, gasUsedWei, gasCostWei);
  }
  return { hash, gasUsedWei, gasCostWei };
}

function failMissingSimulationAccount(): never {
  throw new Error("execute simulation requires an account address");
}

export async function isTargetAllowed(
  vaultOrTarget: `0x${string}`,
  maybeTarget?: `0x${string}`,
): Promise<boolean> {
  const vault = maybeTarget ? vaultOrTarget : aiVaultAddress;
  const target = maybeTarget ?? vaultOrTarget;
  return retryRead(
    "allowedTarget",
    async () =>
      (await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "allowedTarget",
        args: [target],
      })) as boolean,
  );
}
