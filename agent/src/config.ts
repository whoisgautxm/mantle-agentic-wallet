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
export const vaultAddress = addresses.agentVault as `0x${string}`;
export const sinkAddress = addresses.paymentSink as `0x${string}`;

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
