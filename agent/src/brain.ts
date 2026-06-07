import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { formatEther, parseEther } from "viem";
import { planToDecision, type ProtocolAdapter, type TradeIntent } from "./protocols/types.js";
import type { Decision, VaultState } from "./types.js";

const DAY_SECONDS = 24n * 60n * 60n;
const MAX_SELL_POSITION_BPS = 6_000n;

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

export interface DecisionOptions {
  anthropicModel?: string;
  openAiModel?: string;
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

export function parseToolUseIntent(input: any): TradeIntent | { action: "hold"; rationale: string } {
  if (input?.action === "hold") {
    return { action: "hold", rationale: String(input.rationale ?? "") };
  }
  if (input?.action === "buy") {
    if (input.amountMnt === undefined) throw new Error("buy missing amountMnt");
    return {
      action: "buy",
      amountMntWei: parsePositiveEtherAmount(input.amountMnt, "amountMnt"),
      rationale: String(input.rationale ?? ""),
    };
  }
  if (input?.action === "sell") {
    if (input.amountToken === undefined) throw new Error("sell missing amountToken");
    return {
      action: "sell",
      amountTokenWei: parsePositiveEtherAmount(input.amountToken, "amountToken"),
      rationale: String(input.rationale ?? ""),
    };
  }
  throw new Error(`unknown action: ${input?.action}`);
}

function minBigint(...values: bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

function remainingDailyLimit(state: VaultState, nowSeconds: bigint): bigint {
  const spentToday = nowSeconds >= state.windowStart + DAY_SECONDS ? 0n : state.spentToday;
  return spentToday >= state.dailyLimit ? 0n : state.dailyLimit - spentToday;
}

function normalizedRationale(rationale: string, message: string): string {
  return rationale ? `${rationale} Safety sizing: ${message}.` : `Safety sizing: ${message}.`;
}

export function normalizeTradeIntent(
  intent: TradeIntent | { action: "hold"; rationale: string },
  state: VaultState,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1_000)),
): TradeIntent | { action: "hold"; rationale: string } {
  if (intent.action === "hold") return intent;

  if (intent.action === "buy") {
    const requested = intent.amountMntWei ?? 0n;
    const maxBuy = minBigint(state.balanceWei, state.spendLimitPerTx, remainingDailyLimit(state, nowSeconds));
    if (maxBuy <= 0n) {
      return {
        action: "hold",
        rationale: normalizedRationale(intent.rationale, "buy changed to HOLD because no MNT spend capacity remains"),
      };
    }
    const amountMntWei = requested > maxBuy ? maxBuy : requested;
    return {
      ...intent,
      amountMntWei,
      rationale:
        amountMntWei === requested
          ? intent.rationale
          : normalizedRationale(
              intent.rationale,
              `buy capped from ${formatEther(requested)} to ${formatEther(amountMntWei)} MNT`,
            ),
    };
  }

  if (state.tokenBalanceWei <= 0n) {
    return {
      action: "hold",
      rationale: normalizedRationale(intent.rationale, "sell changed to HOLD because token inventory is zero"),
    };
  }
  const requested = intent.amountTokenWei ?? 0n;
  const proportionalCap = (state.tokenBalanceWei * MAX_SELL_POSITION_BPS) / 10_000n;
  const maxSell = proportionalCap > 0n ? proportionalCap : state.tokenBalanceWei;
  const amountTokenWei = requested > maxSell ? maxSell : requested;
  return {
    ...intent,
    amountTokenWei,
    rationale:
      amountTokenWei === requested
        ? intent.rationale
        : normalizedRationale(
            intent.rationale,
            `sell capped from ${formatEther(requested)} to ${formatEther(amountTokenWei)} tokens`,
          ),
  };
}

export async function buildDecisionFromToolUse(
  input: any,
  adapter: ProtocolAdapter,
  state?: VaultState,
): Promise<Decision> {
  const intent = parseToolUseIntent(input);
  const executableIntent = state ? normalizeTradeIntent(intent, state) : intent;
  if (executableIntent.action === "hold") return { kind: "hold", rationale: executableIntent.rationale };
  const quote = await adapter.quote(executableIntent);
  const plan = adapter.buildPlan(executableIntent, quote);
  return planToDecision(plan, executableIntent.rationale);
}

function buildSystemPrompt(state: VaultState): string {
  const maxSellWei = (state.tokenBalanceWei * MAX_SELL_POSITION_BPS) / 10_000n;
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
    "Only sell if tokenBalance > 0. amountMnt and amountToken MUST use human decimal units, never raw wei. " +
    "For unused trade amount fields, return the string \"0\". " +
    `State: mntBalance=${formatEther(state.balanceWei)} MNT (${state.balanceWei} wei), ` +
    `tokenBalance=${formatEther(state.tokenBalanceWei)} tokens (${state.tokenBalanceWei} token-wei), ` +
    `maxSellThisTurn=${formatEther(maxSellWei)} tokens, ` +
    `price=${formatEther(state.priceWei)} MNT/token (${state.priceWei} wei/token), ` +
    `perTxLimit=${formatEther(state.spendLimitPerTx)} MNT, dailyLimit=${formatEther(state.dailyLimit)} MNT, ` +
    `spentToday=${formatEther(state.spentToday)} MNT, paused=${state.paused}.`
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
  adapter: ProtocolAdapter,
  context: string,
  model?: string,
): Promise<Decision> {
  const msg = await client.messages.create({
    model: model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
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
  return buildDecisionFromToolUse(toolUse.input, adapter, state);
}

async function decideWithOpenAI(
  client: OpenAI,
  state: VaultState,
  priceHistory: bigint[],
  adapter: ProtocolAdapter,
  context: string,
  model?: string,
): Promise<Decision> {
  const response = await client.responses.create({
    model: model ?? process.env.OPENAI_MODEL ?? "gpt-5.2",
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
  return buildDecisionFromToolUse(JSON.parse(toolCall.arguments ?? "{}"), adapter, state);
}

/// Calls the configured model provider and returns a parsed Decision.
export async function decide(
  client: ReasoningClient,
  state: VaultState,
  priceHistory: bigint[],
  adapter: ProtocolAdapter,
  context: string,
  options: DecisionOptions = {},
): Promise<Decision> {
  if (client.provider === "openai") {
    if (!client.openai) throw new Error("OpenAI client missing");
    return decideWithOpenAI(client.openai, state, priceHistory, adapter, context, options.openAiModel);
  }

  if (!client.anthropic) throw new Error("Anthropic client missing");
  return decideWithAnthropic(client.anthropic, state, priceHistory, adapter, context, options.anthropicModel);
}
