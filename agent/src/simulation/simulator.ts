import { publicClient } from "../config.js";
import { VAULT_ABI } from "../chain.js";
import type { Decision } from "../types.js";
import type { SimulationResult } from "./types.js";

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;

export async function simulateExecute(
  vault: `0x${string}`,
  decision: ExecuteDecision,
  account: `0x${string}`,
): Promise<SimulationResult> {
  try {
    const result = await publicClient.simulateContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "execute",
      account,
      args: [decision.target, decision.valueWei, decision.calldata, decision.rationale],
    });
    return { ok: true, returnData: result.result as `0x${string}` };
  } catch (error) {
    const e = error as any;
    return {
      ok: false,
      reason: e?.shortMessage ?? e?.message ?? "simulation failed",
    };
  }
}
