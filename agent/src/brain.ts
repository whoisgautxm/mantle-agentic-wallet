import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { formatEther, parseEther } from "viem";
import { computeMarketFeatures, formatMarketFeatures, type MarketFeatures, type MarketRegime } from "./marketFeatures.js";
import { planToDecision, type ProtocolAdapter, type TradeIntent } from "./protocols/types.js";
import type { Decision, DecisionAnalysis, VaultState } from "./types.js";

const DAY_SECONDS = 24n * 60n * 60n;
const MAX_SELL_POSITION_BPS = 6_000n;
const DEFAULT_MIN_CONFIDENCE = 55;
const DEFAULT_EDGE_BUFFER_BPS = 10;
const DEFAULT_DOWNTREND_BUY_MAX_PERCENT = 15;
const DEFAULT_UPTREND_SELL_MAX_PERCENT = 20;
const REGIMES: MarketRegime[] = ["trend_up", "trend_down", "range", "shock", "uncertain"];

export const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "Propose the agent's next DEX trade: buy tokens with MNT, sell tokens for MNT, or hold. " +
    "Respect MNT spend limits on buys and current token balance on sells.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      regime: {
        type: "string",
        enum: REGIMES,
        description: "The market regime inferred from only the supplied observations.",
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Confidence in the regime and action from 0 to 100.",
      },
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      sizePercent: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Maximum percentage of currently available buy capacity or token inventory to use.",
      },
      amountMnt: { type: "string", description: 'MNT to spend buying, e.g. "0.01" (buy only)' },
      amountToken: { type: "string", description: 'tokens to sell, e.g. "0.5" (sell only)' },
      expectedEdgeBps: {
        type: "integer",
        minimum: -10_000,
        maximum: 10_000,
        description: "Expected gross advantage of this action before execution costs, in basis points.",
      },
      invalidationCondition: {
        type: "string",
        description: "A concise observable condition that would invalidate the trade thesis.",
      },
      rationale: { type: "string", description: "why this action, referencing the price trend" },
    },
    required: [
      "regime",
      "confidence",
      "action",
      "sizePercent",
      "amountMnt",
      "amountToken",
      "expectedEdgeBps",
      "invalidationCondition",
      "rationale",
    ],
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
  estimatedExecutionCostBps?: number;
  minimumConfidence?: number;
  edgeBufferBps?: number;
  downtrendBuyMaxPercent?: number;
  uptrendSellMaxPercent?: number;
}

type HoldIntent = { action: "hold"; rationale: string };

export type ParsedToolProposal = (TradeIntent | HoldIntent) & {
  analysis: DecisionAnalysis;
  policyComplete: boolean;
};

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

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function proposalAnalysis(input: any): { analysis: DecisionAnalysis; policyComplete: boolean } {
  const policyComplete =
    input?.regime !== undefined &&
    input?.confidence !== undefined &&
    input?.sizePercent !== undefined &&
    input?.expectedEdgeBps !== undefined &&
    input?.invalidationCondition !== undefined;
  const regime = input?.regime ?? "uncertain";
  if (!REGIMES.includes(regime)) throw new Error(`unknown regime: ${regime}`);
  return {
    policyComplete,
    analysis: {
      regime,
      confidence: boundedInteger(input?.confidence, "confidence", 0, 100, 100),
      sizePercent: boundedInteger(input?.sizePercent, "sizePercent", 0, 100, 100),
      expectedEdgeBps: boundedInteger(input?.expectedEdgeBps, "expectedEdgeBps", -10_000, 10_000, 10_000),
      invalidationCondition: String(input?.invalidationCondition ?? "not provided"),
    },
  };
}

export function parseToolUseIntent(input: any): ParsedToolProposal {
  const proposal = proposalAnalysis(input);
  if (input?.action === "hold") {
    return { action: "hold", rationale: String(input.rationale ?? ""), ...proposal };
  }
  if (input?.action === "buy") {
    if (input.amountMnt === undefined) throw new Error("buy missing amountMnt");
    return {
      action: "buy",
      amountMntWei: parsePositiveEtherAmount(input.amountMnt, "amountMnt"),
      rationale: String(input.rationale ?? ""),
      ...proposal,
    };
  }
  if (input?.action === "sell") {
    if (input.amountToken === undefined) throw new Error("sell missing amountToken");
    return {
      action: "sell",
      amountTokenWei: parsePositiveEtherAmount(input.amountToken, "amountToken"),
      rationale: String(input.rationale ?? ""),
      ...proposal,
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
  intent: TradeIntent | HoldIntent,
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

function policyHold(rationale: string, message: string): HoldIntent {
  return { action: "hold", rationale: normalizedRationale(rationale, message) };
}

function applyDecisionPolicy(
  proposal: ParsedToolProposal,
  state: VaultState,
  features: MarketFeatures,
  options: DecisionOptions,
  nowSeconds: bigint,
): TradeIntent | HoldIntent {
  if (proposal.action === "hold") return proposal;
  const minimumConfidence = options.minimumConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const estimatedCostBps = options.estimatedExecutionCostBps ?? 0;
  const requiredEdgeBps = estimatedCostBps + (options.edgeBufferBps ?? DEFAULT_EDGE_BUFFER_BPS);

  if (proposal.policyComplete && proposal.analysis.confidence < minimumConfidence) {
    return policyHold(
      proposal.rationale,
      `trade changed to HOLD because confidence ${proposal.analysis.confidence} is below ${minimumConfidence}`,
    );
  }
  if (proposal.policyComplete && proposal.analysis.expectedEdgeBps <= requiredEdgeBps) {
    return policyHold(
      proposal.rationale,
      `trade changed to HOLD because expected edge ${proposal.analysis.expectedEdgeBps} bps does not exceed the ${requiredEdgeBps} bps cost threshold`,
    );
  }

  let sizePercent = proposal.analysis.sizePercent;
  if (proposal.action === "buy" && features.regime === "trend_down") {
    sizePercent = Math.min(sizePercent, options.downtrendBuyMaxPercent ?? DEFAULT_DOWNTREND_BUY_MAX_PERCENT);
  }
  if (proposal.action === "sell" && features.regime === "trend_up") {
    sizePercent = Math.min(sizePercent, options.uptrendSellMaxPercent ?? DEFAULT_UPTREND_SELL_MAX_PERCENT);
  }
  if (sizePercent <= 0) return policyHold(proposal.rationale, "trade changed to HOLD because policy size is zero");

  if (proposal.action === "buy") {
    const available = minBigint(state.balanceWei, state.spendLimitPerTx, remainingDailyLimit(state, nowSeconds));
    const policyCap = (available * BigInt(sizePercent)) / 100n;
    if (policyCap <= 0n) return policyHold(proposal.rationale, "buy changed to HOLD because policy capacity is zero");
    const requested = proposal.amountMntWei ?? 0n;
    const amountMntWei = requested > policyCap ? policyCap : requested;
    return {
      action: "buy",
      amountMntWei,
      rationale:
        amountMntWei === requested
          ? proposal.rationale
          : normalizedRationale(
              proposal.rationale,
              `regime-aware sizing capped buy to ${sizePercent}% of available capacity (${formatEther(amountMntWei)} MNT)`,
            ),
    };
  }

  const policyCap = (state.tokenBalanceWei * BigInt(sizePercent)) / 100n;
  if (policyCap <= 0n) return policyHold(proposal.rationale, "sell changed to HOLD because policy capacity is zero");
  const requested = proposal.amountTokenWei ?? 0n;
  const amountTokenWei = requested > policyCap ? policyCap : requested;
  return {
    action: "sell",
    amountTokenWei,
    rationale:
      amountTokenWei === requested
        ? proposal.rationale
        : normalizedRationale(
            proposal.rationale,
            `regime-aware sizing capped sell to ${sizePercent}% of inventory (${formatEther(amountTokenWei)} tokens)`,
          ),
  };
}

export async function buildDecisionFromToolUse(
  input: any,
  adapter: ProtocolAdapter,
  state?: VaultState,
  options: DecisionOptions = {},
  features: MarketFeatures = computeMarketFeatures(state ? [state.priceWei] : []),
): Promise<Decision> {
  const proposal = parseToolUseIntent(input);
  proposal.analysis.marketFeatures = features;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
  const policyIntent = state ? applyDecisionPolicy(proposal, state, features, options, nowSeconds) : proposal;
  const executableIntent = state ? normalizeTradeIntent(policyIntent, state, nowSeconds) : policyIntent;
  if (executableIntent.action === "hold") {
    return { kind: "hold", rationale: executableIntent.rationale, analysis: proposal.analysis };
  }
  const quote = await adapter.quote(executableIntent);
  const plan = adapter.buildPlan(executableIntent, quote);
  return { ...planToDecision(plan, executableIntent.rationale), analysis: proposal.analysis };
}

function buildSystemPrompt(state: VaultState, options: DecisionOptions): string {
  const maxSellWei = (state.tokenBalanceWei * MAX_SELL_POSITION_BPS) / 10_000n;
  const estimatedCostBps = options.estimatedExecutionCostBps ?? 0;
  const requiredEdgeBps = estimatedCostBps + (options.edgeBufferBps ?? DEFAULT_EDGE_BUFFER_BPS);
  return (
    "You are a regime-aware trading agent for a guarded smart-contract vault on Mantle. " +
    "Classify the observed market as trend_up, trend_down, range, shock, or uncertain before proposing an action. " +
    "Do not blindly buy every dip: preserve capital in confirmed downtrends. " +
    "In sustained uptrends, avoid repeatedly selling the winning position; prefer holding or adding modestly when edge remains. " +
    "In ranges, selective mean reversion is appropriate. After a shock, wait for evidence of stabilization or recovery. " +
    "Use only supplied observations and never assume future prices. " +
    "Each turn: buy tokens with MNT, sell tokens for MNT, or hold. " +
    `A trade must have confidence at least ${options.minimumConfidence ?? DEFAULT_MIN_CONFIDENCE} and expected gross edge above ${requiredEdgeBps} bps. ` +
    "Expected edge must be your conservative estimate before fees, slippage, and gas. " +
    "Buys are bounded by per-tx and remaining daily MNT limits; sells are bounded by token balance. " +
    "Size moves modestly and use sizePercent as an upper bound on available capacity or inventory. " +
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

function buildUserPrompt(context: string, priceHistory: bigint[], features: MarketFeatures): string {
  const trend = priceHistory.length
    ? `Recent prices, oldest to newest, wei/token: ${priceHistory.join(", ")}.`
    : "No price history yet.";
  return `${context}\n\n${trend}\nDeterministic market features: ${formatMarketFeatures(features)}.`;
}

async function decideWithAnthropic(
  client: Anthropic,
  state: VaultState,
  priceHistory: bigint[],
  adapter: ProtocolAdapter,
  context: string,
  options: DecisionOptions,
): Promise<Decision> {
  const features = computeMarketFeatures(priceHistory);
  const msg = await client.messages.create({
    model: options.anthropicModel ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: buildSystemPrompt(state, options), cache_control: { type: "ephemeral" } }],
    tools: [PROPOSE_ACTION_TOOL],
    tool_choice: { type: "tool", name: "propose_action" },
    messages: [{ role: "user", content: buildUserPrompt(context, priceHistory, features) }],
  });

  const toolUse = msg.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("model did not call propose_action");
  }
  return buildDecisionFromToolUse(toolUse.input, adapter, state, options, features);
}

async function decideWithOpenAI(
  client: OpenAI,
  state: VaultState,
  priceHistory: bigint[],
  adapter: ProtocolAdapter,
  context: string,
  options: DecisionOptions,
): Promise<Decision> {
  const features = computeMarketFeatures(priceHistory);
  const response = await client.responses.create({
    model: options.openAiModel ?? process.env.OPENAI_MODEL ?? "gpt-5.2",
    input: [
      { role: "system", content: buildSystemPrompt(state, options) },
      { role: "user", content: buildUserPrompt(context, priceHistory, features) },
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
  return buildDecisionFromToolUse(JSON.parse(toolCall.arguments ?? "{}"), adapter, state, options, features);
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
    return decideWithOpenAI(client.openai, state, priceHistory, adapter, context, options);
  }

  if (!client.anthropic) throw new Error("Anthropic client missing");
  return decideWithAnthropic(client.anthropic, state, priceHistory, adapter, context, options);
}
