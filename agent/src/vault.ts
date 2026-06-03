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
] as const;
