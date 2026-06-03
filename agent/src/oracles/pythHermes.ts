import type { OracleRouter } from "./router.js";
import type { PriceSnapshot } from "./types.js";

const PRICE_ID_RE = /^(?:0x)?[a-fA-F0-9]{64}$/;
const ONE = 10n ** 18n;

export const PYTH_MNT_USD_PRICE_ID =
  "0x4e3037c822d852d79af3ac80e35eb420ee3b870dca49f9344a38ef4773fb0585" as const;

export interface PythHermesConfig {
  hermesUrl: string;
  priceId: string;
  apiKey?: string;
  maxAgeSeconds: bigint;
}

export interface PythPriceInput {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesPriceFeed {
  id: string;
  price?: PythPriceInput;
}

interface HermesLatestResponse {
  parsed?: HermesPriceFeed[];
}

export type PythFetch = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

function normalizePriceId(priceId: string): `0x${string}` {
  if (!PRICE_ID_RE.test(priceId)) throw new Error("PYTH_MNT_USD_PRICE_ID must be a 32-byte hex price id");
  return (priceId.startsWith("0x") ? priceId : `0x${priceId}`) as `0x${string}`;
}

function normalizeHermesUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("PYTH_HERMES_URL cannot be empty");
  return trimmed;
}

function scaleToE18(value: bigint, expo: number): bigint {
  const power = 18 + expo;
  if (power >= 0) return value * 10n ** BigInt(power);
  return value / 10n ** BigInt(-power);
}

export function pythPriceToUsdPerMntWei(price: PythPriceInput): bigint {
  const raw = BigInt(price.price);
  if (raw <= 0n) throw new Error("Pyth price must be positive");
  return scaleToE18(raw, price.expo);
}

export function pythPriceToMntPerUsdWei(price: PythPriceInput): bigint {
  const usdPerMntWei = pythPriceToUsdPerMntWei(price);
  return (ONE * ONE) / usdPerMntWei;
}

export function pythConfidenceToMntPerUsdWei(price: PythPriceInput): bigint {
  const rawConf = BigInt(price.conf);
  if (rawConf <= 0n) return 0n;
  const usdConfWei = scaleToE18(rawConf, price.expo);
  const usdPerMntWei = pythPriceToUsdPerMntWei(price);
  return (usdConfWei * ONE) / usdPerMntWei;
}

export function loadPythHermesConfigFromEnv(env = process.env): PythHermesConfig {
  return {
    hermesUrl: env.PYTH_HERMES_URL ?? "https://hermes.pyth.network",
    priceId: env.PYTH_MNT_USD_PRICE_ID ?? PYTH_MNT_USD_PRICE_ID,
    apiKey: env.PYTH_API_KEY,
    maxAgeSeconds: BigInt(env.PYTH_MAX_AGE_SECONDS ?? "120"),
  };
}

export async function fetchPythMntUsdPrice(
  config: PythHermesConfig,
  fetchFn: PythFetch = fetch as PythFetch,
): Promise<PythPriceInput> {
  const priceId = normalizePriceId(config.priceId);
  const url = new URL(`${normalizeHermesUrl(config.hermesUrl)}/v2/updates/price/latest`);
  url.searchParams.append("ids[]", priceId);

  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;
  const response = await fetchFn(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`Pyth Hermes request failed: ${response.status} ${response.statusText ?? ""}`.trim());
  }

  const body = (await response.json()) as HermesLatestResponse;
  const feed = body.parsed?.find((item) => normalizePriceId(item.id) === priceId);
  if (!feed?.price) throw new Error(`Pyth Hermes response missing price for ${priceId}`);
  return feed.price;
}

export function createPythMntUsdOracleRouter(
  config: PythHermesConfig = loadPythHermesConfigFromEnv(),
  fetchFn: PythFetch = fetch as PythFetch,
): OracleRouter {
  return {
    async getPrice(pair: string): Promise<PriceSnapshot> {
      const price = await fetchPythMntUsdPrice(config, fetchFn);
      const updatedAt = BigInt(price.publish_time);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const age = now > updatedAt ? now - updatedAt : 0n;
      return {
        pair,
        priceWei: pythPriceToMntPerUsdWei(price),
        confidenceWei: pythConfidenceToMntPerUsdWei(price),
        source: "pyth",
        updatedAt,
        stale: age > config.maxAgeSeconds,
        maxAgeSeconds: config.maxAgeSeconds,
      };
    },
  };
}
