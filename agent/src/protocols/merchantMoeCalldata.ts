import { encodeFunctionData } from "viem";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const LB_ROUTER_SWAP_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface MerchantMoeSwapPath {
  tokenPath: readonly `0x${string}`[];
  pairBinSteps: readonly bigint[];
  versions: readonly number[];
}

export interface MerchantMoeSwapCalldataInput extends MerchantMoeSwapPath {
  amountIn: bigint;
  amountOutMin: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
}

function assertAddress(address: `0x${string}` | undefined, label: string): `0x${string}` {
  if (!address || !ADDRESS_RE.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function assertPositive(value: bigint, label: string): bigint {
  if (value <= 0n) throw new Error(`${label} must be positive`);
  return value;
}

function assertPath(input: MerchantMoeSwapPath): void {
  if (input.tokenPath.length < 2) throw new Error("Merchant Moe swap tokenPath must include at least two tokens");
  if (input.pairBinSteps.length !== input.tokenPath.length - 1) {
    throw new Error("Merchant Moe pairBinSteps length must equal tokenPath length minus one");
  }
  if (input.versions.length !== input.tokenPath.length - 1) {
    throw new Error("Merchant Moe versions length must equal tokenPath length minus one");
  }

  input.tokenPath.forEach((address, index) => assertAddress(address, `tokenPath[${index}]`));
  input.pairBinSteps.forEach((step, index) => {
    if (step < 0n) throw new Error(`pairBinSteps[${index}] cannot be negative`);
  });
  input.versions.forEach((version, index) => {
    if (!Number.isInteger(version) || version < 0 || version > 3) {
      throw new Error(`versions[${index}] must be an integer between 0 and 3`);
    }
  });
}

export function buildMerchantMoeSwapExactTokensForTokensCalldata(input: MerchantMoeSwapCalldataInput): `0x${string}` {
  assertPath(input);
  assertPositive(input.amountIn, "amountIn");
  assertPositive(input.amountOutMin, "amountOutMin");
  assertPositive(input.deadline, "deadline");
  assertAddress(input.recipient, "recipient");

  return encodeFunctionData({
    abi: LB_ROUTER_SWAP_ABI,
    functionName: "swapExactTokensForTokens",
    args: [
      input.amountIn,
      input.amountOutMin,
      {
        pairBinSteps: [...input.pairBinSteps],
        versions: [...input.versions],
        tokenPath: [...input.tokenPath],
      },
      input.recipient,
      input.deadline,
    ],
  });
}
