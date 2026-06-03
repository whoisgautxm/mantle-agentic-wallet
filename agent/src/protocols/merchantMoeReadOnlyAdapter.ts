import { createPublicClient, http } from "viem";
import { mantle } from "viem/chains";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const UINT128_MAX = (1n << 128n) - 1n;

export const MERCHANT_MOE_MANTLE = {
  chainId: 5000,
  moeRouter: "0xeaEE7EE68874218c3558b40063c42B82D3E7232a" as const,
  lfjAggregatorRouter: "0x45A62B090DF48243F12A21897e7ed91863E2c86b" as const,
  lbRouter: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a" as const,
  lbQuoter: "0x501b8AFd35df20f531fF45F6f695793AC3316c85" as const,
  lbFactory: "0xa6630671775c4EA2743840F9A5016dCf2A104054" as const,
};

export const LB_QUOTER_ABI = [
  {
    type: "function",
    name: "findBestPathFromAmountIn",
    stateMutability: "view",
    inputs: [
      { name: "route", type: "address[]" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "route", type: "address[]" },
          { name: "pairs", type: "address[]" },
          { name: "binSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "amounts", type: "uint128[]" },
          { name: "virtualAmountsWithoutSlippage", type: "uint128[]" },
          { name: "fees", type: "uint128[]" },
        ],
      },
    ],
  },
] as const;

export interface MerchantMoeConfig {
  chainId: number;
  lbQuoter: `0x${string}`;
  lbRouter: `0x${string}`;
  rpcUrl?: string;
}

export interface MerchantMoeQuoteInput {
  route: readonly `0x${string}`[];
  amountIn: bigint;
}

export interface MerchantMoeQuote {
  protocolId: "merchant-moe";
  chainId: number;
  quoter: `0x${string}`;
  router: `0x${string}`;
  route: `0x${string}`[];
  pairs: `0x${string}`[];
  binSteps: bigint[];
  versions: number[];
  amounts: bigint[];
  virtualAmountsWithoutSlippage: bigint[];
  fees: bigint[];
  amountIn: bigint;
  amountOut: bigint;
}

export interface MerchantMoeReadOnlyAdapter {
  id: "merchant-moe";
  mode: "read-only";
  supportedActions: readonly ["buy", "sell"];
  chainId: number;
  config: MerchantMoeConfig;
  quoteExactInput(input: MerchantMoeQuoteInput): Promise<MerchantMoeQuote>;
  buildPlan(): never;
}

function asAddress(value: string | undefined, label: string): `0x${string}` {
  if (!value || !ADDRESS_RE.test(value)) throw new Error(`${label} must be a 20-byte hex address`);
  return value as `0x${string}`;
}

function asRoute(route: readonly `0x${string}`[]): `0x${string}`[] {
  if (route.length < 2) throw new Error("Merchant Moe quote route must include at least input and output tokens");
  return route.map((address, index) => asAddress(address, `route[${index}]`));
}

function asUint128(value: bigint, label: string): bigint {
  if (value <= 0n) throw new Error(`${label} must be positive`);
  if (value > UINT128_MAX) throw new Error(`${label} exceeds uint128`);
  return value;
}

function last<T>(values: readonly T[], label: string): T {
  if (values.length === 0) throw new Error(`${label} was empty`);
  return values[values.length - 1];
}

export function loadMerchantMoeConfigFromEnv(env = process.env): MerchantMoeConfig {
  return {
    chainId: Number(env.MERCHANT_MOE_CHAIN_ID ?? MERCHANT_MOE_MANTLE.chainId),
    lbQuoter: asAddress(env.MERCHANT_MOE_LB_QUOTER ?? MERCHANT_MOE_MANTLE.lbQuoter, "MERCHANT_MOE_LB_QUOTER"),
    lbRouter: asAddress(env.MERCHANT_MOE_LB_ROUTER ?? MERCHANT_MOE_MANTLE.lbRouter, "MERCHANT_MOE_LB_ROUTER"),
    rpcUrl: env.MERCHANT_MOE_RPC_URL ?? env.MANTLE_MAINNET_RPC_URL,
  };
}

export function createMerchantMoePublicClient(config: MerchantMoeConfig) {
  return createPublicClient({
    chain: mantle,
    transport: http(config.rpcUrl ?? "https://rpc.mantle.xyz"),
  });
}

export function createMerchantMoeReadOnlyAdapter(
  client: Pick<ReturnType<typeof createPublicClient>, "readContract">,
  config: MerchantMoeConfig = loadMerchantMoeConfigFromEnv(),
): MerchantMoeReadOnlyAdapter {
  return {
    id: "merchant-moe",
    mode: "read-only",
    supportedActions: ["buy", "sell"],
    chainId: config.chainId,
    config,
    async quoteExactInput(input: MerchantMoeQuoteInput): Promise<MerchantMoeQuote> {
      const route = asRoute(input.route);
      const amountIn = asUint128(input.amountIn, "amountIn");
      const quote = (await client.readContract({
        address: config.lbQuoter,
        abi: LB_QUOTER_ABI,
        functionName: "findBestPathFromAmountIn",
        args: [route, amountIn],
      } as any)) as any;

      const amounts = (quote.amounts as bigint[] | undefined) ?? [];
      return {
        protocolId: "merchant-moe",
        chainId: config.chainId,
        quoter: config.lbQuoter,
        router: config.lbRouter,
        route: (quote.route ?? route) as `0x${string}`[],
        pairs: (quote.pairs ?? []) as `0x${string}`[],
        binSteps: (quote.binSteps ?? []) as bigint[],
        versions: ((quote.versions ?? []) as number[]).map(Number),
        amounts,
        virtualAmountsWithoutSlippage: (quote.virtualAmountsWithoutSlippage ?? []) as bigint[],
        fees: (quote.fees ?? []) as bigint[],
        amountIn,
        amountOut: last(amounts, "Merchant Moe quote amounts"),
      };
    },
    buildPlan(): never {
      throw new Error("Merchant Moe adapter is read-only; execution calldata is intentionally disabled");
    },
  };
}
