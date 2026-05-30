import { publicClient, walletClient, vaultAddress, agentAccount } from "./config.js";
import type { VaultState, Decision } from "./types.js";

export const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
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

export async function readVaultState(): Promise<VaultState> {
  const [balanceWei, spendLimitPerTx, dailyLimit, spentToday, paused] = await Promise.all([
    publicClient.getBalance({ address: vaultAddress }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "spendLimitPerTx" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "dailyLimit" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "spentToday" }),
    publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "paused" }),
  ]);
  return {
    balanceWei,
    spendLimitPerTx: spendLimitPerTx as bigint,
    dailyLimit: dailyLimit as bigint,
    spentToday: spentToday as bigint,
    paused: paused as boolean,
  };
}

export async function submitExecute(d: Extract<Decision, { kind: "execute" }>): Promise<`0x${string}`> {
  const hash = await walletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "execute",
    args: [d.target, d.valueWei, d.calldata, d.rationale],
    account: agentAccount,
  });
  // waitForTransactionReceipt does NOT throw on revert — it resolves with status
  // 'reverted'. Check it explicitly so a failed on-chain action isn't logged as success.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`execute tx reverted on-chain: ${hash}`);
  }
  return hash;
}
