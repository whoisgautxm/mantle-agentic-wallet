import type { Decision } from "./types.js";

export const VAULT_ABI = [
  { type: "function", name: "spendLimitPerTx", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "dailyLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "windowStart", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowedTarget", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "rationale", type: "string" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    type: "function",
    name: "executeGuarded",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "outAsset", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "rationale", type: "string" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;

export function buildVaultExecutionCall(decision: ExecuteDecision):
  | {
      functionName: "execute";
      args: readonly [`0x${string}`, bigint, `0x${string}`, string];
    }
  | {
      functionName: "executeGuarded";
      args: readonly [`0x${string}`, bigint, `0x${string}`, `0x${string}`, bigint, string];
    } {
  const isTrade = decision.action === "buy" || decision.action === "sell";
  if (isTrade || decision.outAsset !== undefined || decision.minOutWei !== undefined) {
    if (!decision.outAsset) throw new Error("guarded trade missing output asset");
    if (decision.minOutWei === undefined || decision.minOutWei <= 0n) {
      throw new Error("guarded trade requires a positive minOutWei");
    }
    return {
      functionName: "executeGuarded",
      args: [
        decision.target,
        decision.valueWei,
        decision.calldata,
        decision.outAsset,
        decision.minOutWei,
        decision.rationale,
      ],
    };
  }
  return {
    functionName: "execute",
    args: [decision.target, decision.valueWei, decision.calldata, decision.rationale],
  };
}
