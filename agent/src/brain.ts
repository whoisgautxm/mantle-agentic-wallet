import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { parseEther } from "viem";
import { encodeBuy, encodeSell } from "./dex.js";
import type { Decision, VaultState } from "./types.js";

export const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "Propose the agent's next DEX trade: buy tokens with MNT, sell tokens for MNT, or hold. " +
    "Respect MNT spend limits on buys and current token balance on sells.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      amountMnt: { type: "string", description: 'MNT to spend buying, e.g. "0.01" (buy only)' },
      amountToken: { type: "string", description: 'tokens to sell, e.g. "0.5" (sell only)' },
      rationale: { type: "string", description: "why this action, referencing the price trend" },
    },
    required: ["action", "amountMnt", "amountToken", "rationale"],
  },
};

export type ReasoningProvider = "anthropic" | "openai";

export interface ReasoningClient {
  provider: ReasoningProvider;
  anthropic?: Anthropic;
  openai?: OpenAI;
}

function parsePositiveEtherAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} must be a decimal string`);
  }
  const raw = String(value).trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(raw)) {
    throw new Error(`${field} must be a positive decimal string`);
  }
  const parsed = parseEther(raw);
  if (parsed <= 0n) throw new Error(`${field} must be positive`);
  return parsed;
}

/// Pure mapping: tool input + DEX address -> contract-faithful Decision.
/// Calldata and wei are computed here, never by the LLM.
export function parseToolUse(input: any, dex: `0x${string}`): Decision {
  if (input?.action === "hold") {
    return { kind: "hold", rationale: String(input.rationale ?? "") };
  }
  if (input?.action === "buy") {
    if (input.amountMnt === undefined) throw new Error("buy missing amountMnt");
    const valueWei = parsePositiveEtherAmount(input.amountMnt, "amountMnt");
    return {
      kind: "execute",
      action: "buy",
      target: dex,
      valueWei,
      calldata: encodeBuy(),
      rationale: String(input.rationale ?? ""),
    };
  }
  if (input?.action === "sell") {
    if (input.amountToken === undefined) throw new Error("sell missing amountToken");
    const amountTokenWei = parsePositiveEtherAmount(input.amountToken, "amountToken");
    return {
      kind: "execute",
      action: "sell",
      target: dex,
      valueWei: 0n,
      amountTokenWei,
      calldata: encodeSell(amountTokenWei),
      rationale: String(input.rationale ?? ""),
    };
  }
  throw new Error(`unknown action: ${input?.action}`);
}

function buildSystemPrompt(state: VaultState): string {
  return (
    "You are an ACTIVE mean-reversion trading agent for a smart-contract vault on Mantle, " +
    "competing head-to-head against a passive dollar-cost-averaging (DCA) baseline. " +
    "Your edge is timing the choppy, range-bound market: " +
    "BUY when the current price is below the average of the recent prices (a dip), and " +
    "SELL part of your token position when the current price is above that recent average (a rip). " +
    "HOLD only when the price is within ~1% of the recent average, or when you have fewer than 2 price points. " +
    "Be decisive and trade on most turns — passivity loses to the baseline, so do not wait for a 'perfect' signal. " +
    "Each turn: buy tokens with MNT, sell tokens for MNT, or hold. " +
    "Buys are bounded by per-tx and remaining daily MNT limits; sells are bounded by token balance. " +
    "Size moves modestly: roughly 0.02-0.05 MNT per buy, or 30-60% of your token balance per sell. " +
    "Only sell if tokenBalance > 0. For unused trade amount fields, return the string \"0\". " +
    `State: mntBalance=${state.balanceWei} wei, tokenBalance=${state.tokenBalanceWei} token-wei, ` +
    `price=${state.priceWei} wei/token, perTxLimit=${state.spendLimitPerTx} wei, ` +
    `dailyLimit=${state.dailyLimit} wei, spentToday=${state.spentToday} wei, paused=${state.paused}.`
  );
}

function buildUserPrompt(context: string, priceHistory: bigint[]): string {
  const trend = priceHistory.length
    ? `Recent prices, oldest to newest, wei/token: ${priceHistory.join(", ")}.`
    : "No price history yet.";
  return `${context}\n\n${trend}`;
}

async function decideWithAnthropic(
  client: Anthropic,
  state: VaultState,
  priceHistory: bigint[],
  dex: `0x${string}`,
  context: string,
): Promise<Decision> {
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: buildSystemPrompt(state), cache_control: { type: "ephemeral" } }],
    tools: [PROPOSE_ACTION_TOOL],
    tool_choice: { type: "tool", name: "propose_action" },
    messages: [{ role: "user", content: buildUserPrompt(context, priceHistory) }],
  });

  const toolUse = msg.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("model did not call propose_action");
  }
  return parseToolUse(toolUse.input, dex);
}

async function decideWithOpenAI(
  client: OpenAI,
  state: VaultState,
  priceHistory: bigint[],
  dex: `0x${string}`,
  context: string,
): Promise<Decision> {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    input: [
      { role: "system", content: buildSystemPrompt(state) },
      { role: "user", content: buildUserPrompt(context, priceHistory) },
    ],
    tools: [
      {
        type: "function",
        name: PROPOSE_ACTION_TOOL.name,
        description: PROPOSE_ACTION_TOOL.description,
        parameters: PROPOSE_ACTION_TOOL.input_schema,
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: PROPOSE_ACTION_TOOL.name },
  } as any);

  const toolCall = (response.output as any[]).find(
    (item) => item?.type === "function_call" && item?.name === PROPOSE_ACTION_TOOL.name,
  );
  if (!toolCall) {
    throw new Error("model did not call propose_action");
  }
  return parseToolUse(JSON.parse(toolCall.arguments ?? "{}"), dex);
}

/// Calls the configured model provider and returns a parsed Decision.
export async function decide(
  client: ReasoningClient,
  state: VaultState,
  priceHistory: bigint[],
  dex: `0x${string}`,
  context: string,
): Promise<Decision> {
  if (client.provider === "openai") {
    if (!client.openai) throw new Error("OpenAI client missing");
    return decideWithOpenAI(client.openai, state, priceHistory, dex, context);
  }

  if (!client.anthropic) throw new Error("Anthropic client missing");
  return decideWithAnthropic(client.anthropic, state, priceHistory, dex, context);
}
