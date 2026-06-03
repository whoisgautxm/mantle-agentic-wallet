import { createPublicClient, formatEther, http } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json";

const ONE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PYTH_MNT_USD_PRICE_ID = "0x4e3037c822d852d79af3ac80e35eb420ee3b870dca49f9344a38ef4773fb0585";

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
    source: "MockDEX" | "Pyth";
    priceWei: bigint;
    confidenceWei?: bigint;
    updatedAt: string;
    stale: boolean;
    dexOracleDeviationBps: bigint;
    warnings: string[];
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

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function scaleToE18(value: bigint, expo: number): bigint {
  const power = 18 + expo;
  if (power >= 0) return value * 10n ** BigInt(power);
  return value / 10n ** BigInt(-power);
}

function pythUsdPerMntToMntPerUsdWei(price: { price: string; expo: number }): bigint {
  const usdPerMntWei = scaleToE18(BigInt(price.price), price.expo);
  if (usdPerMntWei <= 0n) throw new Error("Pyth price must be positive");
  return (ONE * ONE) / usdPerMntWei;
}

function pythConfidenceToMntPerUsdWei(price: { price: string; conf: string; expo: number }): bigint {
  const confWei = scaleToE18(BigInt(price.conf), price.expo);
  const usdPerMntWei = scaleToE18(BigInt(price.price), price.expo);
  if (usdPerMntWei <= 0n) return 0n;
  return (confWei * ONE) / usdPerMntWei;
}

async function readPythOracle(dexPriceWei: bigint): Promise<LiveStatus["oracle"]> {
  const hermesUrl = (process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network").replace(/\/+$/, "");
  const priceId = process.env.PYTH_MNT_USD_PRICE_ID ?? PYTH_MNT_USD_PRICE_ID;
  const maxAgeSeconds = BigInt(process.env.PYTH_MAX_AGE_SECONDS ?? "120");
  const url = new URL(`${hermesUrl}/v2/updates/price/latest`);
  url.searchParams.append("ids[]", priceId);
  const headers = process.env.PYTH_API_KEY ? { Authorization: `Bearer ${process.env.PYTH_API_KEY}` } : undefined;
  const response = await fetch(url, { headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Pyth Hermes request failed: ${response.status}`);
  const body = (await response.json()) as {
    parsed?: Array<{ id: string; price?: { price: string; conf: string; expo: number; publish_time: number } }>;
  };
  const normalizedId = priceId.replace(/^0x/, "").toLowerCase();
  const price = body.parsed?.find((feed) => feed.id.replace(/^0x/, "").toLowerCase() === normalizedId)?.price;
  if (!price) throw new Error("Pyth Hermes response missing MNT/USD price");

  const priceWei = pythUsdPerMntToMntPerUsdWei(price);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const updatedAt = BigInt(price.publish_time);
  const age = now > updatedAt ? now - updatedAt : 0n;
  return {
    pair: "MNT/USD",
    source: "Pyth",
    priceWei,
    confidenceWei: pythConfidenceToMntPerUsdWei(price),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    stale: age > maxAgeSeconds,
    dexOracleDeviationBps: bps(absDiff(dexPriceWei, priceWei), priceWei),
    warnings: [],
  };
}

async function readOracleStatus(dexPriceWei: bigint): Promise<LiveStatus["oracle"]> {
  if ((process.env.ORACLE_PROVIDER ?? "mockdex").toLowerCase() === "pyth") {
    try {
      return await readPythOracle(dexPriceWei);
    } catch (error) {
      const e = error as any;
      return {
        pair: "MNT/MOCK",
        source: "MockDEX",
        priceWei: dexPriceWei,
        updatedAt: new Date().toISOString(),
        stale: false,
        dexOracleDeviationBps: 0n,
        warnings: [`Pyth unavailable; fell back to MockDEX: ${e?.message ?? "unknown error"}`],
      };
    }
  }
  return {
    pair: "MNT/MOCK",
    source: "MockDEX",
    priceWei: dexPriceWei,
    updatedAt: new Date().toISOString(),
    stale: false,
    dexOracleDeviationBps: 0n,
    warnings: [],
  };
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
    const dexPriceWei = await readContract<bigint>({ address: dex, abi: DEX_ABI, functionName: "price" });
    const oracle = await readOracleStatus(dexPriceWei);
    const [ai, baseline] = await Promise.all([
      readVaultStatus(aiVault, dex, oracle.priceWei),
      readVaultStatus(baselineVault, dex, oracle.priceWei),
    ]);
    return {
      ok: true,
      oracle,
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
