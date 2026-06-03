import { createPublicClient, formatEther, http } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json";

const ONE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  transport: http(process.env.MANTLE_RPC_URL ?? "https://rpc.sepolia.mantle.xyz"),
});

const DEX_ABI = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "allowedTarget",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface RiskConfig {
  maxDexOracleDeviationBps: bigint;
  maxPositionBps: bigint;
  maxTradeValueBps: bigint;
}

export interface VaultStatus {
  address: string;
  balanceWei: bigint;
  tokenBalanceWei: bigint;
  tokenValueWei: bigint;
  portfolioWei: bigint;
  positionBps: bigint;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  dailyRemaining: bigint;
  paused: boolean;
  dexAllowed: boolean;
}

export interface LiveStatus {
  ok: true;
  oracle: {
    pair: string;
    source: "MockDEX";
    priceWei: bigint;
    updatedAt: string;
    stale: false;
    dexOracleDeviationBps: bigint;
  };
  risk: {
    config: RiskConfig;
    ai: VaultStatus;
    baseline: VaultStatus;
  };
}

export type StatusResult = LiveStatus | { ok: false; reason: string };

function envBps(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = BigInt(raw);
  return value > 10_000n ? fallback : value;
}

export function readRiskConfig(): RiskConfig {
  return {
    maxDexOracleDeviationBps: envBps("RISK_MAX_DEX_ORACLE_DEVIATION_BPS", 300n),
    maxPositionBps: envBps("RISK_MAX_POSITION_BPS", 7_000n),
    maxTradeValueBps: envBps("RISK_MAX_TRADE_VALUE_BPS", 2_500n),
  };
}

function bps(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator * 10_000n) / denominator;
}

function deployed(address: string | undefined): address is `0x${string}` {
  return Boolean(address && address !== ZERO);
}

async function readContract<T>(params: {
  address: `0x${string}`;
  abi: typeof DEX_ABI | typeof VAULT_ABI;
  functionName: string;
  args?: readonly unknown[];
}): Promise<T> {
  return (await client.readContract(params as any)) as T;
}

async function readVaultStatus(vault: `0x${string}`, dex: `0x${string}`, priceWei: bigint): Promise<VaultStatus> {
  const balanceWei = await client.getBalance({ address: vault });
  const spendLimitPerTx = await readContract<bigint>({
    address: vault,
    abi: VAULT_ABI,
    functionName: "spendLimitPerTx",
  });
  const dailyLimit = await readContract<bigint>({
    address: vault,
    abi: VAULT_ABI,
    functionName: "dailyLimit",
  });
  const spentToday = await readContract<bigint>({
    address: vault,
    abi: VAULT_ABI,
    functionName: "spentToday",
  });
  const paused = await readContract<boolean>({ address: vault, abi: VAULT_ABI, functionName: "paused" });
  const dexAllowed = await readContract<boolean>({
    address: vault,
    abi: VAULT_ABI,
    functionName: "allowedTarget",
    args: [dex],
  });
  const tokenBalanceWei = await readContract<bigint>({
    address: dex,
    abi: DEX_ABI,
    functionName: "tokenBalance",
    args: [vault],
  });

  const tokenValueWei = (tokenBalanceWei * priceWei) / ONE;
  const portfolioWei = balanceWei + tokenValueWei;
  const dailyRemaining = spentToday >= dailyLimit ? 0n : dailyLimit - spentToday;

  return {
    address: vault,
    balanceWei,
    tokenBalanceWei,
    tokenValueWei,
    portfolioWei,
    positionBps: bps(tokenValueWei, portfolioWei),
    spendLimitPerTx,
    dailyLimit,
    spentToday,
    dailyRemaining,
    paused,
    dexAllowed,
  };
}

export async function getLiveStatus(): Promise<StatusResult> {
  const dex = addresses.mockDex as `0x${string}`;
  const aiVault = ((addresses as any).aiVault ?? addresses.agentVault) as `0x${string}`;
  const baselineVault = (addresses as any).baselineVault as `0x${string}`;
  if (!deployed(dex) || !deployed(aiVault) || !deployed(baselineVault)) {
    return { ok: false, reason: "contracts are not deployed in shared/addresses.json" };
  }

  try {
    const priceWei = await readContract<bigint>({ address: dex, abi: DEX_ABI, functionName: "price" });
    const [ai, baseline] = await Promise.all([
      readVaultStatus(aiVault, dex, priceWei),
      readVaultStatus(baselineVault, dex, priceWei),
    ]);
    return {
      ok: true,
      oracle: {
        pair: "MNT/MOCK",
        source: "MockDEX",
        priceWei,
        updatedAt: new Date().toISOString(),
        stale: false,
        dexOracleDeviationBps: 0n,
      },
      risk: {
        config: readRiskConfig(),
        ai,
        baseline,
      },
    };
  } catch (error) {
    const e = error as any;
    return { ok: false, reason: e?.shortMessage ?? e?.message ?? "live status unavailable" };
  }
}

export function formatMnt(value: bigint): string {
  return `${Number(formatEther(value)).toFixed(5)} MNT`;
}

export function formatBps(value: bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}
