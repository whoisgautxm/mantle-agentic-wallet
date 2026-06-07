import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json" with { type: "json" };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const chain = mantleSepoliaTestnet;
export const aiVaultAddress = ((addresses as any).aiVault ?? addresses.agentVault) as `0x${string}`;
export const baselineVaultAddress = (addresses as any).baselineVault as `0x${string}`;
export const dexAddress = (addresses as any).mockDex as `0x${string}`;
export const mockTokenAddress = (addresses as any).mockToken as `0x${string}`;
export const vaultAddress = aiVaultAddress;

export const agentAccount = privateKeyToAccount(env("AGENT_PRIVATE_KEY") as `0x${string}`);

export const publicClient = createPublicClient({
  chain,
  transport: http(env("MANTLE_RPC_URL")),
});

export const walletClient = createWalletClient({
  account: agentAccount,
  chain,
  transport: http(env("MANTLE_RPC_URL")),
});

export function getBaselineWalletClient() {
  const baselineAccount = privateKeyToAccount(env("BASELINE_PRIVATE_KEY") as `0x${string}`);
  return createWalletClient({
    account: baselineAccount,
    chain,
    transport: http(env("MANTLE_RPC_URL")),
  });
}

export function getOwnerWalletClient() {
  const ownerAccount = privateKeyToAccount(env("OWNER_PRIVATE_KEY") as `0x${string}`);
  return createWalletClient({
    account: ownerAccount,
    chain,
    transport: http(env("MANTLE_RPC_URL")),
  });
}
