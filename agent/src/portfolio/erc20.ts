import type { TokenBalance, TokenInfo } from "./types.js";

export const ERC20_ABI = [
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
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function readContract<T>(client: any, params: Record<string, unknown>): Promise<T> {
  return (await client.readContract(params as any)) as T;
}

export async function readTokenBalance(
  client: any,
  token: TokenInfo,
  owner: `0x${string}`,
): Promise<TokenBalance> {
  const balanceRaw = await readContract<bigint>(client, {
    address: token.address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  return { token, owner, balanceRaw };
}

export async function readAllowance(
  client: any,
  token: TokenInfo,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return readContract<bigint>(client, {
    address: token.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
}
