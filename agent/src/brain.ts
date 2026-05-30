import Anthropic from "@anthropic-ai/sdk";
import { encodeFunctionData, parseEther } from "viem";
import type { Decision, VaultState } from "./types.js";

export const SINK_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "payable",
    inputs: [{ name: "memo", type: "string" }],
    outputs: [],
  },
] as const;

export const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "Propose the agent's next action: pay the treasury sink, or hold. " +
    "Respect the vault's per-tx and daily limits.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["pay", "hold"] },
      amountMnt: { type: "string", description: 'amount of MNT to pay, decimal string e.g. "0.001" (pay only)' },
      memo: { type: "string", description: "short memo recorded on-chain (pay only)" },
      rationale: { type: "string", description: "why this action" },
    },
    required: ["action", "rationale"],
  },
};

/// Pure mapping: tool input + the allowlisted sink address -> a contract-faithful
/// Decision. Calldata and wei are computed HERE, not by the LLM. Throws on malformed pay.
export function parseToolUse(input: any, sink: `0x${string}`): Decision {
  if (input?.action === "hold") {
    return { kind: "hold", rationale: String(input.rationale ?? "") };
  }
  if (input?.action === "pay") {
    if (input.amountMnt === undefined || input.memo === undefined) {
      throw new Error("pay proposal missing amountMnt/memo");
    }
    return {
      kind: "execute",
      target: sink,
      valueWei: parseEther(String(input.amountMnt)),
      calldata: encodeFunctionData({ abi: SINK_ABI, functionName: "pay", args: [String(input.memo)] }),
      rationale: String(input.rationale ?? ""),
    };
  }
  throw new Error(`unknown action: ${input?.action}`);
}

/// Calls Claude with the propose_action tool and returns a parsed Decision.
export async function decide(
  client: Anthropic,
  state: VaultState,
  context: string,
  sink: `0x${string}`,
): Promise<Decision> {
  const sys =
    "You are an autonomous treasury agent for a smart-contract vault on Mantle. " +
    "Each turn you may pay the treasury sink a small amount of MNT, or hold. " +
    "Never propose an amount above the per-tx or remaining daily limit. " +
    `Vault: balance=${state.balanceWei} wei, perTxLimit=${state.spendLimitPerTx} wei, ` +
    `dailyLimit=${state.dailyLimit} wei, spentToday=${state.spentToday} wei, paused=${state.paused}.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
    tools: [PROPOSE_ACTION_TOOL],
    tool_choice: { type: "tool", name: "propose_action" },
    messages: [{ role: "user", content: context }],
  });

  const toolUse = msg.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("model did not call propose_action");
  }
  return parseToolUse(toolUse.input, sink);
}
