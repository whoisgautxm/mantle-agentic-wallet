import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { formatEther, parseEther } from "viem";
import { computeMarketFeatures, formatMarketFeatures, type MarketFeatures, type MarketRegime } from "./marketFeatures.js";
import { planToDecision, type ProtocolAdapter, type TradeIntent } from "./protocols/types.js";
import { evaluateCostGate, type CostGateResult } from "./risk/costGate.js";
import {
  DEFAULT_EDGE_BUFFER_BPS,
  DEFAULT_MIN_CONFIDENCE,
  type StrategyFunction,
  type StrategyIntent,
} from "./strategies/ensemble.js";
import type { Decision, DecisionAnalysis, VaultState } from "./types.js";

const DAY_SECONDS = 24n * 60n * 60n;
const MAX_SELL_POSITION_BPS = 6_000n;
const DEFAULT_DOWNTREND_BUY_MAX_PERCENT = 15;
const DEFAULT_UPTREND_SELL_MAX_PERCENT = 20;
const DEFAULT_STRATEGY_BASELINE_BUY_WEI = 5n * 10n ** 15n;
const WEI_PER_ETHER = 10n ** 18n;
const REGIMES: MarketRegime[] = ["trend_up", "trend_down", "range", "shock", "uncertain"];
const VETO_CODES = ["none", "state_inconsistency", "regime_conflict", "evidence_insufficient", "tail_risk"] as const;

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

export const ASSESS_CANDIDATE_TOOL = {
  name: "assess_trade_candidate",
  description:
    "Approve or veto exactly one deterministic, economically pre-screened DeFi trade candidate. " +
    "Do not invent a new action, amount, or expected edge.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      candidateId: {
        type: "string",
        description: "The id of the supplied candidate being assessed.",
      },
      verdict: {
        type: "string",
        enum: ["approve", "veto"],
        description: "Approve the supplied candidate or veto it with a supported veto code.",
      },
      vetoCode: {
        type: "string",
        enum: VETO_CODES,
        description: "Use none for approve. For veto, choose the strongest supported reason.",
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Confidence in this assessment from 0 to 100.",
      },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string" },
        description: "Short evidence bullets grounded only in the supplied state and features.",
      },
      rationale: {
        type: "string",
        description: "Concise reasoning for the approval or veto.",
      },
    },
    required: ["candidateId", "verdict", "vetoCode", "confidence", "evidence", "rationale"],
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
  preModelGasEstimateUnits?: bigint;
  preModelGasPriceWei?: bigint;
  feeBps?: number;
  slippageBps?: number;
  costBufferBps?: number;
  minimumConfidence?: number;
  edgeBufferBps?: number;
  downtrendBuyMaxPercent?: number;
  uptrendSellMaxPercent?: number;
  strategyPrior?: StrategyFunction;
  strategyBaselineBuyWei?: bigint;
}

type HoldIntent = { action: "hold"; rationale: string };

export type ParsedToolProposal = (TradeIntent | HoldIntent) & {
  analysis: DecisionAnalysis;
  policyComplete: boolean;
};

export interface TradeCandidate {
  id: string;
  action: "buy" | "sell";
  amountMntWei?: bigint;
  amountTokenWei?: bigint;
  regime: MarketRegime;
  confidence: number;
  sizePercent: number;
  expectedEdgeBps: number;
  estimatedExecutionCostBps: number;
  rationale: string;
  evidence: string[];
}

export interface CandidateBuildResult {
  candidate?: TradeCandidate;
  hold?: Decision;
  strategyIntent?: StrategyIntent;
  economicGate?: CostGateResult;
  analysis: DecisionAnalysis;
  reason: string;
}

export type CandidateVetoCode = (typeof VETO_CODES)[number];

export interface CandidateAssessment {
  candidateId: string;
  verdict: "approve" | "veto";
  vetoCode: CandidateVetoCode;
  confidence: number;
  evidence: string[];
  rationale: string;
}

export interface CandidateAssessmentValidation {
  ok: boolean;
  reason?: string;
  finalVerdict: "approved" | "vetoed" | "invalid_veto_ignored" | "invalid_approval_logged";
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

function decisionAnalysisFromStrategy(intent: StrategyIntent, features: MarketFeatures): DecisionAnalysis {
  return {
    regime: features.regime,
    confidence: features.confidence,
    sizePercent: intent.sizePercent,
    expectedEdgeBps: intent.expectedEdgeBps,
    invalidationCondition: "candidate invalid if regime, price, inventory, or execution-cost evidence changes",
    marketFeatures: features,
  };
}

function tradeNotionalWei(intent: TradeIntent, state: VaultState): bigint {
  if (intent.action === "buy") return intent.amountMntWei ?? 0n;
  return ((intent.amountTokenWei ?? 0n) * state.priceWei) / WEI_PER_ETHER;
}

function candidateId(intent: TradeIntent, state: VaultState, features: MarketFeatures): string {
  const amount =
    intent.action === "buy"
      ? intent.amountMntWei?.toString() ?? "0"
      : intent.amountTokenWei?.toString() ?? "0";
  return [
    "ensemble",
    features.regime,
    intent.action,
    state.blockNumber?.toString() ?? "latest",
    state.priceWei.toString(),
    amount,
  ].join(":");
}

function candidateEvidence(features: MarketFeatures, state: VaultState, intent: TradeIntent): string[] {
  const inventory =
    state.tokenBalanceWei > 0n
      ? `token inventory ${formatEther(state.tokenBalanceWei)}`
      : "token inventory is zero; buys use cash only";
  return [
    `regime=${features.regime}, confidence=${features.confidence}`,
    `shortSlopeBps=${features.shortSlopeBps}, longSlopeBps=${features.longSlopeBps}, momentumBps=${features.momentumBps}`,
    inventory,
    intent.action === "buy"
      ? `buy amount ${formatEther(intent.amountMntWei ?? 0n)} MNT`
      : `sell amount ${formatEther(intent.amountTokenWei ?? 0n)} token`,
  ];
}

function attachAgentTrace<T extends Decision>(decision: T, agentTrace: Record<string, unknown>): T {
  return { ...decision, agentTrace };
}

export function buildCandidateFromStrategy(
  state: VaultState,
  priceHistory: readonly bigint[],
  features: MarketFeatures,
  options: DecisionOptions,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1_000)),
): CandidateBuildResult {
  const strategyIntent = options.strategyPrior?.({
    priceHistory,
    features,
    state,
    baselineBuyWei: options.strategyBaselineBuyWei ?? DEFAULT_STRATEGY_BASELINE_BUY_WEI,
    estimatedExecutionCostBps: options.estimatedExecutionCostBps,
  });

  if (!strategyIntent) {
    const analysis: DecisionAnalysis = {
      regime: features.regime,
      confidence: features.confidence,
      sizePercent: 0,
      expectedEdgeBps: 0,
      invalidationCondition: "no deterministic strategy prior configured",
      marketFeatures: features,
    };
    return {
      analysis,
      reason: "strategy_prior_missing",
      hold: attachAgentTrace(
        { kind: "hold", rationale: "No deterministic candidate generator configured.", analysis },
        { decisionMode: "legacy_model_fallback", candidateGate: { reason: "strategy_prior_missing" } },
      ),
    };
  }

  const analysis = decisionAnalysisFromStrategy(strategyIntent, features);
  if (strategyIntent.action === "hold") {
    return {
      analysis,
      reason: "strategy_hold",
      strategyIntent,
      hold: attachAgentTrace(
        { kind: "hold", rationale: strategyIntent.rationale, analysis },
        { decisionMode: "candidate_pre_gate", strategyIntent, candidateGate: { reason: "strategy_hold" } },
      ),
    };
  }

  const normalized = normalizeTradeIntent(strategyIntent, state, nowSeconds);
  if (normalized.action === "hold") {
    return {
      analysis,
      reason: "normalization_hold",
      strategyIntent,
      hold: attachAgentTrace(
        { kind: "hold", rationale: normalized.rationale, analysis },
        { decisionMode: "candidate_pre_gate", strategyIntent, candidateGate: { reason: "normalization_hold" } },
      ),
    };
  }

  const fixedRequiredEdgeBps =
    (options.estimatedExecutionCostBps ?? 0) + (options.edgeBufferBps ?? DEFAULT_EDGE_BUFFER_BPS);
  if (strategyIntent.expectedEdgeBps <= fixedRequiredEdgeBps) {
    const reason = `expected edge ${strategyIntent.expectedEdgeBps} bps does not exceed fixed pre-model threshold ${fixedRequiredEdgeBps} bps`;
    return {
      analysis,
      reason: "fixed_cost_hold",
      strategyIntent,
      hold: attachAgentTrace(
        { kind: "hold", rationale: normalizedRationale(strategyIntent.rationale, reason), analysis },
        {
          decisionMode: "candidate_pre_gate",
          strategyIntent,
          candidateGate: { reason: "fixed_cost_hold", requiredEdgeBps: fixedRequiredEdgeBps },
        },
      ),
    };
  }

  const notionalWei = tradeNotionalWei(normalized, state);
  let economicGate: CostGateResult | undefined;
  if (options.preModelGasEstimateUnits !== undefined && options.preModelGasPriceWei !== undefined) {
    economicGate = evaluateCostGate({
      expectedEdgeBps: strategyIntent.expectedEdgeBps,
      feeBps: options.feeBps ?? 0,
      slippageBps: options.slippageBps ?? 0,
      bufferBps: options.costBufferBps ?? options.edgeBufferBps ?? DEFAULT_EDGE_BUFFER_BPS,
      gasEstimateWei: options.preModelGasEstimateUnits,
      gasPriceWei: options.preModelGasPriceWei,
      tradeNotionalWei: notionalWei,
    });
    if (!economicGate.ok) {
      return {
        analysis,
        reason: "economic_pre_gate_hold",
        strategyIntent,
        economicGate,
        hold: attachAgentTrace(
          {
            kind: "hold",
            rationale: normalizedRationale(
              strategyIntent.rationale,
              `candidate held before model call because ${economicGate.reason}`,
            ),
            analysis,
          },
          {
            decisionMode: "candidate_pre_gate",
            strategyIntent,
            candidateGate: { reason: "economic_pre_gate_hold", economicGate, tradeNotionalWei },
          },
        ),
      };
    }
  }

  return {
    analysis,
    reason: "candidate_ready",
    strategyIntent,
    economicGate,
    candidate: {
      id: candidateId(normalized, state, features),
      action: normalized.action,
      amountMntWei: normalized.action === "buy" ? normalized.amountMntWei : undefined,
      amountTokenWei: normalized.action === "sell" ? normalized.amountTokenWei : undefined,
      regime: features.regime,
      confidence: features.confidence,
      sizePercent: strategyIntent.sizePercent,
      expectedEdgeBps: strategyIntent.expectedEdgeBps,
      estimatedExecutionCostBps: fixedRequiredEdgeBps,
      rationale: normalized.rationale,
      evidence: candidateEvidence(features, state, normalized),
    },
  };
}

export function parseCandidateAssessment(input: any): CandidateAssessment {
  const verdict = input?.verdict;
  if (verdict !== "approve" && verdict !== "veto") throw new Error(`unknown candidate assessment verdict: ${verdict}`);
  const vetoCode = input?.vetoCode;
  if (!VETO_CODES.includes(vetoCode)) throw new Error(`unknown candidate vetoCode: ${vetoCode}`);
  if (verdict === "approve" && vetoCode !== "none") {
    throw new Error("approved candidate assessments must use vetoCode=none");
  }
  if (verdict === "veto" && vetoCode === "none") {
    throw new Error("vetoed candidate assessments must use a non-none vetoCode");
  }
  const evidence = Array.isArray(input?.evidence) ? input.evidence.map((entry: unknown) => String(entry)) : [];
  if (!evidence.length) throw new Error("candidate assessment evidence must be non-empty");
  return {
    candidateId: String(input?.candidateId ?? ""),
    verdict,
    vetoCode,
    confidence: boundedInteger(input?.confidence, "confidence", 0, 100, 0),
    evidence,
    rationale: String(input?.rationale ?? ""),
  };
}

function assessmentText(assessment: CandidateAssessment): string {
  return [assessment.rationale, ...assessment.evidence].join(" ").toLowerCase();
}

export function validateCandidateAssessment(
  assessment: CandidateAssessment,
  candidate: TradeCandidate,
  state: VaultState,
): CandidateAssessmentValidation {
  if (assessment.candidateId !== candidate.id) {
    return {
      ok: false,
      reason: `assessment candidateId ${assessment.candidateId} did not match ${candidate.id}`,
      finalVerdict: assessment.verdict === "veto" ? "invalid_veto_ignored" : "invalid_approval_logged",
    };
  }
  if (candidate.action === "sell" && state.tokenBalanceWei <= 0n) {
    return {
      ok: false,
      reason: "candidate attempted to sell while token inventory is zero",
      finalVerdict: assessment.verdict === "veto" ? "invalid_veto_ignored" : "invalid_approval_logged",
    };
  }
  if (state.tokenBalanceWei <= 0n) {
    const text = assessmentText(assessment);
    const hallucinatedPosition =
      /winning position/.test(text) ||
      /existing token position/.test(text) ||
      /preserv\w*\s+(?:the\s+)?(?:winning\s+)?position/.test(text) ||
      /avoid\w*\s+(?:repeatedly\s+)?selling/.test(text);
    if (hallucinatedPosition) {
      return {
        ok: false,
        reason: "POSITION_HALLUCINATION: assessment referenced preserving/selling a token position while tokenBalance is zero",
        finalVerdict: assessment.verdict === "veto" ? "invalid_veto_ignored" : "invalid_approval_logged",
      };
    }
  }
  return {
    ok: true,
    finalVerdict: assessment.verdict === "approve" ? "approved" : "vetoed",
  };
}

function candidateIntent(candidate: TradeCandidate, rationale: string): TradeIntent {
  if (candidate.action === "buy") {
    return {
      action: "buy",
      amountMntWei: candidate.amountMntWei ?? 0n,
      rationale,
    };
  }
  return {
    action: "sell",
    amountTokenWei: candidate.amountTokenWei ?? 0n,
    rationale,
  };
}

export async function buildDecisionFromApprovedCandidate(
  candidate: TradeCandidate,
  adapter: ProtocolAdapter,
  analysis: DecisionAnalysis,
  rationale: string,
  traceBase: Record<string, unknown> = {},
): Promise<Decision> {
  const intent = candidateIntent(candidate, rationale);
  const quote = await adapter.quote(intent);
  const plan = adapter.buildPlan(intent, quote);
  return attachAgentTrace(
    { ...planToDecision(plan, rationale), analysis },
    {
      ...traceBase,
      candidate,
      quote,
      plan,
    },
  );
}

export async function buildDecisionFromCandidateAssessment(
  candidate: TradeCandidate,
  assessment: CandidateAssessment,
  adapter: ProtocolAdapter,
  state: VaultState,
  analysis: DecisionAnalysis,
  traceBase: Record<string, unknown> = {},
): Promise<Decision> {
  const validation = validateCandidateAssessment(assessment, candidate, state);
  const agentTrace = {
    ...traceBase,
    decisionMode: "candidate_assessment",
    candidate,
    modelAssessment: assessment,
    assessmentValidation: validation,
  };

  if (assessment.verdict === "veto" && validation.ok) {
    return attachAgentTrace(
      {
        kind: "hold",
        rationale: `OpenAI vetoed deterministic candidate (${assessment.vetoCode}): ${assessment.rationale}`,
        analysis,
      },
      agentTrace,
    );
  }

  const ignoredInvalidVeto = assessment.verdict === "veto" && !validation.ok;
  const rationale = ignoredInvalidVeto
    ? normalizedRationale(candidate.rationale, `OpenAI veto ignored because ${validation.reason}`)
    : normalizedRationale(candidate.rationale, `OpenAI approved candidate: ${assessment.rationale}`);
  return buildDecisionFromApprovedCandidate(
    candidate,
    adapter,
    analysis,
    rationale,
    {
      ...agentTrace,
    },
  );
}

function applyStrategyPrior(
  proposal: ParsedToolProposal,
  prior: StrategyIntent,
): ParsedToolProposal {
  if (proposal.action === "hold") return proposal;
  if (prior.action === "hold") {
    return {
      action: "hold",
      rationale: normalizedRationale(
        proposal.rationale,
        `ensemble prior changed trade to HOLD: ${prior.rationale}`,
      ),
      analysis: proposal.analysis,
      policyComplete: proposal.policyComplete,
    };
  }
  if (proposal.action !== prior.action) {
    return {
      action: "hold",
      rationale: normalizedRationale(
        proposal.rationale,
        `ensemble prior rejected ${proposal.action} because it routed to ${prior.action}`,
      ),
      analysis: proposal.analysis,
      policyComplete: proposal.policyComplete,
    };
  }

  const analysis = {
    ...proposal.analysis,
    sizePercent: Math.min(proposal.analysis.sizePercent, prior.sizePercent),
    expectedEdgeBps: Math.min(proposal.analysis.expectedEdgeBps, prior.expectedEdgeBps),
  };
  if (proposal.action === "buy") {
    const amountMntWei = minBigint(proposal.amountMntWei ?? 0n, prior.amountMntWei ?? 0n);
    if (amountMntWei <= 0n) {
      return {
        action: "hold",
        rationale: normalizedRationale(proposal.rationale, "ensemble prior buy capacity is zero"),
        analysis,
        policyComplete: proposal.policyComplete,
      };
    }
    return {
      action: "buy",
      amountMntWei,
      rationale: normalizedRationale(
        proposal.rationale,
        `ensemble prior capped buy to ${formatEther(amountMntWei)} MNT`,
      ),
      analysis,
      policyComplete: proposal.policyComplete,
    };
  }

  const amountTokenWei = minBigint(proposal.amountTokenWei ?? 0n, prior.amountTokenWei ?? 0n);
  if (amountTokenWei <= 0n) {
    return {
      action: "hold",
      rationale: normalizedRationale(proposal.rationale, "ensemble prior sell capacity is zero"),
      analysis,
      policyComplete: proposal.policyComplete,
    };
  }
  return {
    action: "sell",
    amountTokenWei,
    rationale: normalizedRationale(
      proposal.rationale,
      `ensemble prior capped sell to ${formatEther(amountTokenWei)} tokens`,
    ),
    analysis,
    policyComplete: proposal.policyComplete,
  };
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
  priceHistory: readonly bigint[] = state ? [state.priceWei] : [],
): Promise<Decision> {
  let proposal = parseToolUseIntent(input);
  proposal.analysis.marketFeatures = features;
  if (state && options.strategyPrior) {
    const prior = options.strategyPrior({
      priceHistory,
      features,
      state,
      baselineBuyWei: options.strategyBaselineBuyWei ?? DEFAULT_STRATEGY_BASELINE_BUY_WEI,
      estimatedExecutionCostBps: options.estimatedExecutionCostBps,
    });
    proposal = applyStrategyPrior(proposal, prior);
  }
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
    "In sustained uptrends, evaluate adding only when cash is available and the edge clears costs; never claim to preserve token exposure when tokenBalance is zero. " +
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

function buildCandidateAssessmentSystemPrompt(state: VaultState): string {
  return (
    "You are an OpenAI DeFi candidate critic for a guarded Mantle vault. " +
    "The deterministic strategy has already selected one trade candidate and fixed its action, amount, edge, and regime. " +
    "Your job is only to approve that candidate or veto it with a supported veto code and grounded evidence. " +
    "Do not propose a different action or amount. " +
    "State invariants: HOLD means no position change. If tokenBalance is 0, holding preserves cash, not a winning token position. " +
    "SELL is impossible when tokenBalance is 0. Never describe exposure that is absent from the supplied state. " +
    "Veto only for state_inconsistency, regime_conflict, evidence_insufficient, or tail_risk. " +
    `Current balances: mntBalance=${formatEther(state.balanceWei)} MNT, tokenBalance=${formatEther(state.tokenBalanceWei)} tokens, ` +
    `price=${formatEther(state.priceWei)} MNT/token, paused=${state.paused}.`
  );
}

function buildUserPrompt(context: string, priceHistory: bigint[], features: MarketFeatures): string {
  const trend = priceHistory.length
    ? `Recent prices, oldest to newest, wei/token: ${priceHistory.join(", ")}.`
    : "No price history yet.";
  return `${context}\n\n${trend}\nDeterministic market features: ${formatMarketFeatures(features)}.`;
}

function candidateAssessmentPrompt(
  context: string,
  priceHistory: readonly bigint[],
  features: MarketFeatures,
  candidate: TradeCandidate,
): string {
  const candidateJson = JSON.stringify({
    ...candidate,
    amountMntWei: candidate.amountMntWei?.toString(),
    amountTokenWei: candidate.amountTokenWei?.toString(),
  });
  return [
    context,
    priceHistory.length
      ? `Recent prices, oldest to newest, wei/token: ${priceHistory.join(", ")}.`
      : "No price history yet.",
    `Deterministic market features: ${formatMarketFeatures(features)}.`,
    `Candidate JSON: ${candidateJson}`,
    "Return assess_trade_candidate for exactly this candidateId.",
  ].join("\n\n");
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
  return buildDecisionFromToolUse(toolUse.input, adapter, state, options, features, priceHistory);
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
  if (options.strategyPrior) {
    const candidateResult = buildCandidateFromStrategy(state, priceHistory, features, options);
    if (!candidateResult.candidate) {
      if (!candidateResult.hold) {
        throw new Error(`candidate generation failed without hold decision: ${candidateResult.reason}`);
      }
      return candidateResult.hold;
    }
    const response = await client.responses.create({
      model: options.openAiModel ?? process.env.OPENAI_MODEL ?? "gpt-5.2",
      input: [
        { role: "system", content: buildCandidateAssessmentSystemPrompt(state) },
        { role: "user", content: candidateAssessmentPrompt(context, priceHistory, features, candidateResult.candidate) },
      ],
      tools: [
        {
          type: "function",
          name: ASSESS_CANDIDATE_TOOL.name,
          description: ASSESS_CANDIDATE_TOOL.description,
          parameters: ASSESS_CANDIDATE_TOOL.input_schema,
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: ASSESS_CANDIDATE_TOOL.name },
    } as any);

    const toolCall = (response.output as any[]).find(
      (item) => item?.type === "function_call" && item?.name === ASSESS_CANDIDATE_TOOL.name,
    );
    if (!toolCall) {
      return {
        kind: "hold",
        rationale: "OpenAI did not return a candidate assessment; held instead of executing.",
        analysis: candidateResult.analysis,
        agentTrace: {
          decisionMode: "candidate_assessment",
          candidate: candidateResult.candidate,
          strategyIntent: candidateResult.strategyIntent,
          candidateGate: { reason: candidateResult.reason, economicGate: candidateResult.economicGate },
          modelAssessmentError: "missing assess_trade_candidate tool call",
        },
      };
    }

    let assessment: CandidateAssessment;
    try {
      assessment = parseCandidateAssessment(JSON.parse(toolCall.arguments ?? "{}"));
    } catch (error) {
      return {
        kind: "hold",
        rationale: `OpenAI candidate assessment was invalid; held instead of executing: ${(error as Error).message}`,
        analysis: candidateResult.analysis,
        agentTrace: {
          decisionMode: "candidate_assessment",
          candidate: candidateResult.candidate,
          strategyIntent: candidateResult.strategyIntent,
          candidateGate: { reason: candidateResult.reason, economicGate: candidateResult.economicGate },
          modelAssessmentError: error,
        },
      };
    }

    return buildDecisionFromCandidateAssessment(
      candidateResult.candidate,
      assessment,
      adapter,
      state,
      candidateResult.analysis,
      {
        strategyIntent: candidateResult.strategyIntent,
        candidateGate: { reason: candidateResult.reason, economicGate: candidateResult.economicGate },
      },
    );
  }

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
  return buildDecisionFromToolUse(JSON.parse(toolCall.arguments ?? "{}"), adapter, state, options, features, priceHistory);
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
