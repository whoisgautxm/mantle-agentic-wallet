import { publicClient, walletClient, aiVaultAddress, dexAddress } from "./config.js";
import { DEX_ABI } from "./dex.js";
import type { Decision, VaultState } from "./types.js";

export const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "windowStart", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowedTarget", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
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
    outputs: [{ type: "bytes" }],
  },
] as const;

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;
type AgentWalletClient = typeof walletClient;

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

export async function readPrice(): Promise<bigint> {
  return retryRead(
    "price",
    async () =>
      (await publicClient.readContract({
        address: dexAddress,
        abi: DEX_ABI,
        functionName: "price",
      })) as bigint,
  );
}

export async function readVaultState(vault: `0x${string}` = aiVaultAddress): Promise<VaultState> {
  const balanceWei = await retryRead("vault balance", () => publicClient.getBalance({ address: vault }));
  const spendLimitPerTx = await retryRead("spendLimitPerTx", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spendLimitPerTx" }),
  );
  const dailyLimit = await retryRead("dailyLimit", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "dailyLimit" }),
  );
  const spentToday = await retryRead("spentToday", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentToday" }),
  );
  const windowStart = await retryRead("windowStart", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "windowStart" }),
  );
  const paused = await retryRead("paused", () =>
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" }),
  );
  const tokenBalanceWei = await retryRead("tokenBalance", () =>
    publicClient.readContract({ address: dexAddress, abi: DEX_ABI, functionName: "tokenBalance", args: [vault] }),
  );
  const priceWei = await readPrice();

  return {
    balanceWei,
    spendLimitPerTx: spendLimitPerTx as bigint,
    dailyLimit: dailyLimit as bigint,
    spentToday: spentToday as bigint,
    windowStart: windowStart as bigint,
    paused: paused as boolean,
    tokenBalanceWei: tokenBalanceWei as bigint,
    priceWei: priceWei as bigint,
  };
}

export async function submitExecute(
  vault: `0x${string}`,
  d: ExecuteDecision,
  client: AgentWalletClient = walletClient,
): Promise<`0x${string}`> {
  const hash = await client.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "execute",
    args: [d.target, d.valueWei, d.calldata, d.rationale],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`execute tx reverted on-chain: ${hash}`);
  }
  return hash;
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
