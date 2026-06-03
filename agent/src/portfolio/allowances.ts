import type { AllowanceInfo, AllowanceStatus, SpenderInfo, TokenInfo } from "./types.js";

export const MAX_UINT256 = (1n << 256n) - 1n;

export function classifyAllowance(
  allowanceRaw: bigint,
  expectedSpendRaw = 0n,
  excessiveMultiplier = 5n,
): AllowanceStatus {
  if (allowanceRaw === 0n) return "none";
  if (allowanceRaw >= MAX_UINT256 / 2n) return "unbounded";
  if (expectedSpendRaw > 0n && allowanceRaw > expectedSpendRaw * excessiveMultiplier) return "excessive";
  return "bounded";
}

export function isUnsafeAllowance(status: AllowanceStatus): boolean {
  return status === "excessive" || status === "unbounded";
}

export function buildAllowanceInfo(input: {
  token: TokenInfo;
  owner: `0x${string}`;
  spender: SpenderInfo;
  allowanceRaw: bigint;
  expectedSpendRaw?: bigint;
}): AllowanceInfo {
  const status = classifyAllowance(input.allowanceRaw, input.expectedSpendRaw ?? 0n);
  return {
    token: input.token,
    owner: input.owner,
    spender: input.spender,
    allowanceRaw: input.allowanceRaw,
    status,
    unsafe: isUnsafeAllowance(status),
  };
}
