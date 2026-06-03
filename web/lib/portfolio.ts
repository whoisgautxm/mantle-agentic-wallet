import { createPublicClient, formatUnits, http } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  transport: http(process.env.MANTLE_RPC_URL ?? "https://rpc.sepolia.mantle.xyz"),
});

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface PortfolioToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  riskTier: string;
  pricePair?: string;
}

export interface PortfolioSpender {
  name: string;
  address: `0x${string}`;
  riskTier: string;
}

export interface BalanceRow {
  vaultName: string;
  vault: `0x${string}`;
  token: PortfolioToken;
  balanceRaw: bigint;
}

export interface AllowanceRow {
  vaultName: string;
  vault: `0x${string}`;
  token: PortfolioToken;
  spender: PortfolioSpender;
  allowanceRaw: bigint;
  status: "none" | "bounded" | "excessive" | "unbounded";
  unsafe: boolean;
}

export type PortfolioStatus =
  | {
      ok: true;
      configured: boolean;
      tokens: PortfolioToken[];
      spenders: PortfolioSpender[];
      balances: BalanceRow[];
      allowances: AllowanceRow[];
    }
  | { ok: false; reason: string };

function asAddress(value: string, label: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) throw new Error(`${label} must be a 20-byte hex address`);
  return value as `0x${string}`;
}

export function parsePortfolioTokens(raw = process.env.PORTFOLIO_TOKENS ?? ""): PortfolioToken[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [symbol, address, decimals, riskTier = "experimental", pricePair] = entry.split(":");
      const parsedDecimals = Number(decimals);
      if (!symbol || !address || !Number.isInteger(parsedDecimals)) {
        throw new Error("PORTFOLIO_TOKENS entries must be SYMBOL:address:decimals[:riskTier[:pricePair]]");
      }
      return {
        symbol,
        address: asAddress(address, `${symbol} address`),
        decimals: parsedDecimals,
        riskTier,
        pricePair,
      };
    });
}

export function parsePortfolioSpenders(raw = process.env.PORTFOLIO_SPENDERS ?? ""): PortfolioSpender[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, address, riskTier = "experimental"] = entry.split(":");
      if (!name || !address) {
        throw new Error("PORTFOLIO_SPENDERS entries must be NAME:address[:riskTier]");
      }
      return {
        name,
        address: asAddress(address, `${name} address`),
        riskTier,
      };
    });
}

async function readContract<T>(params: {
  address: `0x${string}`;
  functionName: string;
  args: readonly unknown[];
}): Promise<T> {
  return (await client.readContract({ address: params.address, abi: ERC20_ABI, functionName: params.functionName, args: params.args } as any)) as T;
}

function classifyAllowance(allowanceRaw: bigint): AllowanceRow["status"] {
  if (allowanceRaw === 0n) return "none";
  if (allowanceRaw >= MAX_UINT256 / 2n) return "unbounded";
  return "bounded";
}

export async function getPortfolioStatus(vaults: Array<{ name: string; address: `0x${string}` }>): Promise<PortfolioStatus> {
  try {
    const tokens = parsePortfolioTokens();
    const spenders = parsePortfolioSpenders();
    if (tokens.length === 0) {
      return { ok: true, configured: false, tokens, spenders, balances: [], allowances: [] };
    }

    const balances: BalanceRow[] = [];
    const allowances: AllowanceRow[] = [];
    for (const vault of vaults) {
      for (const token of tokens) {
        const balanceRaw = await readContract<bigint>({
          address: token.address,
          functionName: "balanceOf",
          args: [vault.address],
        });
        balances.push({ vaultName: vault.name, vault: vault.address, token, balanceRaw });

        for (const spender of spenders) {
          const allowanceRaw = await readContract<bigint>({
            address: token.address,
            functionName: "allowance",
            args: [vault.address, spender.address],
          });
          const status = classifyAllowance(allowanceRaw);
          allowances.push({
            vaultName: vault.name,
            vault: vault.address,
            token,
            spender,
            allowanceRaw,
            status,
            unsafe: status === "excessive" || status === "unbounded",
          });
        }
      }
    }

    return { ok: true, configured: true, tokens, spenders, balances, allowances };
  } catch (error) {
    const e = error as any;
    return { ok: false, reason: e?.shortMessage ?? e?.message ?? "portfolio status unavailable" };
  }
}

export function formatTokenAmount(value: bigint, token: PortfolioToken): string {
  const formatted = Number(formatUnits(value, token.decimals));
  return `${formatted.toFixed(formatted === 0 ? 2 : 6)} ${token.symbol}`;
}
