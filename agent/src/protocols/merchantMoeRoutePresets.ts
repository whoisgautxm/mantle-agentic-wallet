export type MerchantMoeReferenceSource = "none" | "manual" | "pyth-mnt-usd";

export interface MerchantMoeTokenConfig {
  symbol: "WMNT" | "USDC" | "USDT" | "USDe" | "MOE";
  address: `0x${string}`;
  decimals: number;
  source: "mantle-token-list" | "onchain-erc20" | "merchant-moe-docs";
}

export interface MerchantMoeRoutePreset {
  id: string;
  label: string;
  route: `0x${string}`[];
  tokenInDecimals: number;
  tokenOutDecimals: number;
  referenceSource: MerchantMoeReferenceSource;
  maxDeviationBps: bigint;
  amountInWei: bigint;
  notes: string;
}

export const MERCHANT_MOE_TOKENS = {
  WMNT: {
    symbol: "WMNT",
    address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
    decimals: 18,
    source: "onchain-erc20",
  },
  USDC: {
    symbol: "USDC",
    address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
    decimals: 6,
    source: "mantle-token-list",
  },
  USDT: {
    symbol: "USDT",
    address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
    decimals: 6,
    source: "onchain-erc20",
  },
  USDe: {
    symbol: "USDe",
    address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
    decimals: 18,
    source: "mantle-token-list",
  },
  MOE: {
    symbol: "MOE",
    address: "0x4515A45337F461A11Ff0FE8aBF3c606AE5dC00c9",
    decimals: 18,
    source: "merchant-moe-docs",
  },
} as const satisfies Record<string, MerchantMoeTokenConfig>;

const oneTenthMnt = 10n ** 17n;

export const MERCHANT_MOE_ROUTE_PRESETS = {
  "wmnt-usdc-direct": {
    id: "wmnt-usdc-direct",
    label: "WMNT -> USDC direct",
    route: [MERCHANT_MOE_TOKENS.WMNT.address, MERCHANT_MOE_TOKENS.USDC.address],
    tokenInDecimals: MERCHANT_MOE_TOKENS.WMNT.decimals,
    tokenOutDecimals: MERCHANT_MOE_TOKENS.USDC.decimals,
    referenceSource: "pyth-mnt-usd",
    maxDeviationBps: 500n,
    amountInWei: oneTenthMnt,
    notes: "Conservative default stable route; live smoke showed tight quote-vs-Pyth deviation for 0.1 WMNT.",
  },
  "wmnt-moe-usdc": {
    id: "wmnt-moe-usdc",
    label: "WMNT -> MOE -> USDC",
    route: [MERCHANT_MOE_TOKENS.WMNT.address, MERCHANT_MOE_TOKENS.MOE.address, MERCHANT_MOE_TOKENS.USDC.address],
    tokenInDecimals: MERCHANT_MOE_TOKENS.WMNT.decimals,
    tokenOutDecimals: MERCHANT_MOE_TOKENS.USDC.decimals,
    referenceSource: "pyth-mnt-usd",
    maxDeviationBps: 500n,
    amountInWei: oneTenthMnt,
    notes: "Optional liquidity route with more moving parts; keep behind fork simulation and deviation checks.",
  },
  "wmnt-usdt-direct": {
    id: "wmnt-usdt-direct",
    label: "WMNT -> USDT direct",
    route: [MERCHANT_MOE_TOKENS.WMNT.address, MERCHANT_MOE_TOKENS.USDT.address],
    tokenInDecimals: MERCHANT_MOE_TOKENS.WMNT.decimals,
    tokenOutDecimals: MERCHANT_MOE_TOKENS.USDT.decimals,
    referenceSource: "pyth-mnt-usd",
    maxDeviationBps: 500n,
    amountInWei: oneTenthMnt,
    notes: "Secondary stable route; USDT metadata verified on-chain over Mantle mainnet.",
  },
  "wmnt-usde-direct": {
    id: "wmnt-usde-direct",
    label: "WMNT -> USDe direct",
    route: [MERCHANT_MOE_TOKENS.WMNT.address, MERCHANT_MOE_TOKENS.USDe.address],
    tokenInDecimals: MERCHANT_MOE_TOKENS.WMNT.decimals,
    tokenOutDecimals: MERCHANT_MOE_TOKENS.USDe.decimals,
    referenceSource: "pyth-mnt-usd",
    maxDeviationBps: 750n,
    amountInWei: oneTenthMnt,
    notes: "Experimental stable route; wider threshold reflects USDe-specific risk until a dedicated reference feed is wired.",
  },
} as const satisfies Record<string, MerchantMoeRoutePreset>;

export type MerchantMoeRoutePresetId = keyof typeof MERCHANT_MOE_ROUTE_PRESETS;

export function routePresetIds(): MerchantMoeRoutePresetId[] {
  return Object.keys(MERCHANT_MOE_ROUTE_PRESETS) as MerchantMoeRoutePresetId[];
}

export function getMerchantMoeRoutePreset(id: string | undefined): MerchantMoeRoutePreset | undefined {
  if (!id?.trim()) return undefined;
  return MERCHANT_MOE_ROUTE_PRESETS[id.trim() as MerchantMoeRoutePresetId];
}
