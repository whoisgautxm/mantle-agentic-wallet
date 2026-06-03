import type { ExecutionProtection } from "./types.js";

export interface ExecutionProtectionConfig {
  slippageBps: bigint;
  deadlineSeconds?: bigint;
}

function parseBps(raw: string | undefined, fallback: bigint, label: string): bigint {
  if (!raw?.trim()) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be an integer`);
  const value = BigInt(raw.trim());
  if (value > 10_000n) throw new Error(`${label} cannot exceed 10000`);
  return value;
}

function parseOptionalSeconds(raw: string | undefined, label: string): bigint | undefined {
  if (!raw?.trim()) return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${label} must be an integer`);
  const value = BigInt(raw.trim());
  if (value <= 0n) throw new Error(`${label} must be positive`);
  return value;
}

export function loadExecutionProtectionFromEnv(
  env = process.env,
  prefix = "EXECUTION",
): ExecutionProtectionConfig {
  return {
    slippageBps: parseBps(env[`${prefix}_SLIPPAGE_BPS`], 100n, `${prefix}_SLIPPAGE_BPS`),
    deadlineSeconds: parseOptionalSeconds(env[`${prefix}_DEADLINE_SECONDS`], `${prefix}_DEADLINE_SECONDS`),
  };
}

export function applySlippageBps(amountOutWei: bigint | undefined, slippageBps: bigint): bigint | undefined {
  if (amountOutWei === undefined) return undefined;
  if (amountOutWei < 0n) throw new Error("amountOutWei cannot be negative");
  if (slippageBps < 0n || slippageBps > 10_000n) throw new Error("slippageBps must be between 0 and 10000");
  return (amountOutWei * (10_000n - slippageBps)) / 10_000n;
}

export function buildExecutionProtection(
  expectedOutWei: bigint | undefined,
  config: ExecutionProtectionConfig,
): ExecutionProtection {
  return {
    slippageBps: config.slippageBps,
    minOutWei: applySlippageBps(expectedOutWei, config.slippageBps),
    deadlineSeconds: config.deadlineSeconds,
  };
}
