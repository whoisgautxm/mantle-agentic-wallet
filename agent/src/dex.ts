import { encodeFunctionData } from "viem";

export const DEX_ABI = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "buy", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenAmount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [{ name: "price", type: "uint256" }],
    outputs: [],
  },
] as const;

export function encodeBuy(): `0x${string}` {
  return encodeFunctionData({ abi: DEX_ABI, functionName: "buy" });
}

export function encodeSell(tokenAmountWei: bigint): `0x${string}` {
  return encodeFunctionData({ abi: DEX_ABI, functionName: "sell", args: [tokenAmountWei] });
}
