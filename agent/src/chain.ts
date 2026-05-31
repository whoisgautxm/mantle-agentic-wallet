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

export async function readPrice(): Promise<bigint> {
  return (await publicClient.readContract({
    address: dexAddress,
    abi: DEX_ABI,
    functionName: "price",
  })) as bigint;
}

export async function readVaultState(vault: `0x${string}` = aiVaultAddress): Promise<VaultState> {
  const [balanceWei, spendLimitPerTx, dailyLimit, spentToday, windowStart, paused, tokenBalanceWei, priceWei] =
    await Promise.all([
      publicClient.getBalance({ address: vault }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spendLimitPerTx" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "dailyLimit" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentToday" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "windowStart" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" }),
      publicClient.readContract({ address: dexAddress, abi: DEX_ABI, functionName: "tokenBalance", args: [vault] }),
      readPrice(),
    ]);

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
  return (await publicClient.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "allowedTarget",
    args: [target],
  })) as boolean;
}
