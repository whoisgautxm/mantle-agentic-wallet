import { mantleSepoliaTestnet } from "viem/chains";
import type { SpenderInfo, TokenInfo, TokenRiskTier } from "./types.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_TIERS = new Set<TokenRiskTier>(["core", "stable", "volatile", "experimental"]);
const SPENDER_TIERS = new Set<SpenderInfo["riskTier"]>(["trusted", "known", "experimental"]);

function asAddress(value: string, label: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) throw new Error(`${label} must be a 20-byte hex address`);
  return value as `0x${string}`;
}

function asTokenTier(value: string | undefined): TokenRiskTier {
  if (value && TOKEN_TIERS.has(value as TokenRiskTier)) return value as TokenRiskTier;
  return "experimental";
}

function asSpenderTier(value: string | undefined): SpenderInfo["riskTier"] {
  if (value && SPENDER_TIERS.has(value as SpenderInfo["riskTier"])) return value as SpenderInfo["riskTier"];
  return "experimental";
}

export function parseTokenRegistry(raw = process.env.PORTFOLIO_TOKENS ?? ""): TokenInfo[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [symbol, address, decimals, riskTier, pricePair] = entry.split(":");
      if (!symbol || !address || !decimals) {
        throw new Error("PORTFOLIO_TOKENS entries must be SYMBOL:address:decimals[:riskTier[:pricePair]]");
      }
      const parsedDecimals = Number(decimals);
      if (!Number.isInteger(parsedDecimals) || parsedDecimals < 0 || parsedDecimals > 36) {
        throw new Error(`invalid decimals for ${symbol}`);
      }
      return {
        chainId: mantleSepoliaTestnet.id,
        symbol,
        address: asAddress(address, `${symbol} address`),
        decimals: parsedDecimals,
        riskTier: asTokenTier(riskTier),
        pricePair,
      };
    });
}

export function parseSpenderRegistry(raw = process.env.PORTFOLIO_SPENDERS ?? ""): SpenderInfo[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, address, riskTier] = entry.split(":");
      if (!name || !address) {
        throw new Error("PORTFOLIO_SPENDERS entries must be NAME:address[:riskTier]");
      }
      return {
        name,
        address: asAddress(address, `${name} address`),
        riskTier: asSpenderTier(riskTier),
      };
    });
}
