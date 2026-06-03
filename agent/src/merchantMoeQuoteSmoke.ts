import "dotenv/config";
import { pathToFileURL } from "url";
import {
  createMerchantMoePublicClient,
  createMerchantMoeReadOnlyAdapter,
  loadMerchantMoeConfigFromEnv,
  type MerchantMoeQuote,
  type MerchantMoeReadOnlyAdapter,
} from "./protocols/merchantMoeReadOnlyAdapter.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface MerchantMoeQuoteSmokeConfig {
  route: `0x${string}`[];
  amountIn: bigint;
}

function asAddress(value: string, label: string): `0x${string}` {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) throw new Error(`${label} must be a 20-byte hex address`);
  return trimmed as `0x${string}`;
}

export function parseMerchantMoeQuoteSmokeConfig(env = process.env): MerchantMoeQuoteSmokeConfig {
  const routeRaw = env.MERCHANT_MOE_ROUTE;
  if (!routeRaw?.trim()) {
    throw new Error("MERCHANT_MOE_ROUTE is required, e.g. tokenIn,tokenOut");
  }

  const route = routeRaw
    .split(",")
    .map((value, index) => asAddress(value, `MERCHANT_MOE_ROUTE[${index}]`));
  if (route.length < 2) throw new Error("MERCHANT_MOE_ROUTE must include at least tokenIn,tokenOut");

  const amountRaw = env.MERCHANT_MOE_AMOUNT_IN_WEI;
  if (!amountRaw?.trim() || !/^\d+$/.test(amountRaw.trim())) {
    throw new Error("MERCHANT_MOE_AMOUNT_IN_WEI is required as a positive integer raw token amount");
  }
  const amountIn = BigInt(amountRaw.trim());
  if (amountIn <= 0n) throw new Error("MERCHANT_MOE_AMOUNT_IN_WEI must be positive");

  return { route, amountIn };
}

function bigintList(values: readonly bigint[]): string {
  return values.map((value) => value.toString()).join(", ");
}

export function formatMerchantMoeQuote(quote: MerchantMoeQuote): string {
  return [
    "[merchant-moe] read-only quote smoke",
    `chainId: ${quote.chainId}`,
    `quoter: ${quote.quoter}`,
    `router: ${quote.router}`,
    `route: ${quote.route.join(" -> ")}`,
    `amountIn: ${quote.amountIn.toString()}`,
    `amountOut: ${quote.amountOut.toString()}`,
    `pairs: ${quote.pairs.length ? quote.pairs.join(", ") : "none"}`,
    `binSteps: ${bigintList(quote.binSteps) || "none"}`,
    `versions: ${quote.versions.length ? quote.versions.join(", ") : "none"}`,
    `fees: ${bigintList(quote.fees) || "none"}`,
    "execution: disabled; this command never builds or submits swap calldata",
  ].join("\n");
}

export async function runMerchantMoeQuoteSmoke(
  adapter: Pick<MerchantMoeReadOnlyAdapter, "quoteExactInput">,
  env = process.env,
  write: (message: string) => void = console.log,
): Promise<MerchantMoeQuote> {
  const input = parseMerchantMoeQuoteSmokeConfig(env);
  const quote = await adapter.quoteExactInput(input);
  write(formatMerchantMoeQuote(quote));
  return quote;
}

export async function main(): Promise<void> {
  const config = loadMerchantMoeConfigFromEnv();
  const client = createMerchantMoePublicClient(config);
  const adapter = createMerchantMoeReadOnlyAdapter(client, config);
  await runMerchantMoeQuoteSmoke(adapter);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] quote smoke failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
