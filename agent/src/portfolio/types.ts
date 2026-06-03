export type TokenRiskTier = "core" | "stable" | "volatile" | "experimental";

export interface TokenInfo {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  riskTier: TokenRiskTier;
  pricePair?: string;
}

export interface SpenderInfo {
  name: string;
  address: `0x${string}`;
  riskTier: "trusted" | "known" | "experimental";
}

export interface TokenBalance {
  token: TokenInfo;
  owner: `0x${string}`;
  balanceRaw: bigint;
}

export type AllowanceStatus = "none" | "bounded" | "excessive" | "unbounded";

export interface AllowanceInfo {
  token: TokenInfo;
  owner: `0x${string}`;
  spender: SpenderInfo;
  allowanceRaw: bigint;
  status: AllowanceStatus;
  unsafe: boolean;
}
