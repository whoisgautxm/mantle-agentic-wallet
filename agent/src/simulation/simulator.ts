import { buildVaultExecutionCall, VAULT_ABI } from "../vault.js";
import type { Decision } from "../types.js";
import type { SimulationResult } from "./types.js";

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;

export interface ExecuteSimulationClient {
  simulateContract(args: unknown): Promise<{ result?: unknown }>;
  estimateContractGas?(args: unknown): Promise<bigint>;
}

export interface SimulateExecuteOptions {
  client?: ExecuteSimulationClient;
  estimateGas?: boolean;
}

function errorReason(error: unknown): string {
  const e = error as any;
  return e?.shortMessage ?? e?.details ?? e?.message ?? "simulation failed";
}

function hexReturnData(result: unknown): `0x${string}` | undefined {
  return typeof result === "string" && result.startsWith("0x") ? (result as `0x${string}`) : undefined;
}

async function defaultPublicClient(): Promise<ExecuteSimulationClient> {
  const { publicClient } = await import("../config.js");
  return publicClient;
}

export async function simulateExecute(
  vault: `0x${string}`,
  decision: ExecuteDecision,
  account: `0x${string}`,
  options: SimulateExecuteOptions = {},
): Promise<SimulationResult> {
  const client = options.client ?? (await defaultPublicClient());
  try {
    const execution = buildVaultExecutionCall(decision);
    const call = {
      address: vault,
      abi: VAULT_ABI,
      functionName: execution.functionName,
      account,
      args: execution.args,
    };
    const result = await client.simulateContract(call);
    const warnings: string[] = [];
    let gasEstimate: bigint | undefined;

    if (options.estimateGas !== false && client.estimateContractGas) {
      try {
        gasEstimate = await client.estimateContractGas(call);
      } catch (error) {
        warnings.push(`gas estimate unavailable: ${errorReason(error)}`);
      }
    }

    return { ok: true, returnData: hexReturnData(result.result), gasEstimate, warnings };
  } catch (error) {
    const reason = errorReason(error);
    return {
      ok: false,
      reason,
      revertReason: reason,
      warnings: [],
    };
  }
}

export function assertSimulationSucceeded(simulation: SimulationResult): void {
  if (!simulation.ok) {
    throw new Error(`execute simulation failed: ${simulation.reason ?? simulation.revertReason ?? "unknown reason"}`);
  }
}
