import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config as loadDotenv } from "dotenv";
import OpenAI from "openai";
import { formatEther, parseEther } from "viem";
import {
  ASSESS_CANDIDATE_TOOL,
  buildCandidateFromStrategy,
  buildDecisionFromCandidateAssessment,
  decide,
  normalizeTradeIntent,
  parseCandidateAssessment,
  type CandidateAssessment,
  type TradeCandidate,
  type ReasoningClient,
} from "./brain.js";
import { computeMarketFeatures, formatMarketFeatures } from "./marketFeatures.js";
import { portfolioValueWei, roiBps } from "./pnl.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { planToDecision, type ProtocolAdapter, type TradeIntent } from "./protocols/types.js";
import { evaluateRisk } from "./risk/engine.js";
import { DEFAULT_RISK_LIMITS } from "./risk/limits.js";
import type { RiskResult } from "./risk/types.js";
import {
  regimeRoutedEnsemble,
  loadEnsembleConfigFromEnv,
  type StrategyFunction,
  type StrategyIntent,
} from "./strategies/ensemble.js";
import type { Decision, DecisionAnalysis, VaultState } from "./types.js";

const DEX = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;
const ONE = 10n ** 18n;
const BPS = 10_000n;
const MAX_HISTORY = 12;
const COMPARATOR_NAMES = ["dca", "buy-and-hold", "momentum", "mean-reversion", "deterministic-ensemble", "hold"] as const;

export type BenchmarkComparator = (typeof COMPARATOR_NAMES)[number];

export interface MarketRegimeFixture {
  id: string;
  label: string;
  description: string;
  prices: string[];
}

export interface MultiRegimeFixture {
  version: 1;
  name: string;
  initialPortfolio: {
    mnt: string;
    token: string;
  };
  baseline: {
    buyMnt: string;
  };
  costs: {
    swapFeeBps: number;
    slippageBps: number;
    gasMnt: string;
  };
  vaultLimits: {
    spendPerTxMnt: string;
    dailySpendMnt: string;
  };
  regimes: MarketRegimeFixture[];
}

interface ParsedFixture {
  name: string;
  initialMntWei: bigint;
  initialTokenWei: bigint;
  baselineBuyWei: bigint;
  costs: BenchmarkCosts;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  regimes: Array<Omit<MarketRegimeFixture, "prices"> & { pricesWei: bigint[] }>;
}

export interface BenchmarkCosts {
  swapFeeBps: bigint;
  slippageBps: bigint;
  gasWei: bigint;
}

export interface BenchmarkDecisionInput {
  regimeId: string;
  tickIndex: number;
  state: VaultState;
  priceHistory: bigint[];
  adapter: ProtocolAdapter;
  costs: BenchmarkCosts;
  baselineBuyWei: bigint;
}

export type BenchmarkDecisionRunner = (input: BenchmarkDecisionInput) => Promise<Decision>;

export interface BenchmarkTickResult {
  tick: number;
  priceWei: string;
  action: string;
  outcome: "executed" | "blocked" | "hold" | "error";
  ruleId: string;
  rationale: string;
  analysis?: DecisionAnalysis;
  decisionMode?: string;
  candidateId?: string;
  modelVerdict?: string;
  modelVetoCode?: string;
  modelAssessmentConfidence?: number;
  assessmentFinalVerdict?: string;
  assessmentValidationOk?: boolean;
  assessmentValidationReason?: string;
  modelAssessmentError?: string;
  assessmentCacheStatus?: string;
  assessmentCacheKey?: string;
  providerRateLimitDeferred?: boolean;
  portfolioValueWei: string;
  portfolioRoiBps: string;
  cumulativeCostsWei: string;
}

export interface BenchmarkRunnerScore {
  netRoiBps: string;
  drawdownPenaltyBps: string;
  transactionCostPenaltyBps: string;
  blockedPenaltyBps: string;
  errorPenaltyBps: string;
  compositeScoreBps: string;
}

export interface BenchmarkModelAssessmentSummary {
  candidateEvents: number;
  candidatesAssessed: number;
  approvals: number;
  vetoes: number;
  validVetoes: number;
  invalidVetoesIgnored: number;
  invalidApprovalsLogged: number;
  assessmentErrors: number;
  stateGroundingErrors: number;
  approvedExecutions: number;
  approvalPrecisionBps: string;
  suppressedFeasibleCandidates: number;
  providerRateLimitSkips: number;
  assessmentBudgetSkips: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface BenchmarkIncrementalValueGate {
  comparator: "deterministic-ensemble";
  passed: boolean;
  reason: string;
  aiAverageCompositeScoreBps: string;
  comparatorAverageCompositeScoreBps: string;
  compositeEdgeBps: string;
  aiAverageNetRoiBps: string;
  comparatorAverageNetRoiBps: string;
  netRoiEdgeBps: string;
  aiWorstDrawdownBps: string;
  comparatorWorstDrawdownBps: string;
  drawdownImprovementBps: string;
}

export interface BenchmarkRunnerResult {
  runner: "ai" | BenchmarkComparator;
  ticks: number;
  executed: number;
  blocked: number;
  held: number;
  errors: number;
  buys: number;
  sells: number;
  turnoverWei: string;
  totalCostsWei: string;
  grossPortfolioValueWei: string;
  netPortfolioValueWei: string;
  grossRoiBps: string;
  netRoiBps: string;
  transactionCostDragBps: string;
  maxDrawdownBps: string;
  score: BenchmarkRunnerScore;
  timeline: BenchmarkTickResult[];
}

export interface BenchmarkRegimeResult {
  id: string;
  label: string;
  description: string;
  priceStartWei: string;
  priceEndWei: string;
  winner: "ai" | "baseline" | "tie";
  aiEdgeBps: string;
  ai: BenchmarkRunnerResult;
  baseline: BenchmarkRunnerResult;
  comparators: Record<BenchmarkComparator, BenchmarkRunnerResult>;
}

export interface MultiRegimeBenchmarkReport {
  ok: boolean;
  mode: "multi-regime-benchmark";
  fixture: string;
  model: string;
  liveModel: boolean;
  generatedAt: string;
  assumptions: {
    swapFeeBps: string;
    slippageBps: string;
    gasWeiPerExecution: string;
    baselineBuyWei: string;
  };
  aggregate: {
    regimes: number;
    aiWins: number;
    baselineWins: number;
    ties: number;
    aiAverageNetRoiBps: string;
    baselineAverageNetRoiBps: string;
    aiAverageEdgeBps: string;
    aiAverageCompositeScoreBps: string;
    baselineAverageCompositeScoreBps: string;
    aiAverageEdgeVsBuyAndHoldBps: string;
    aiWorstDrawdownBps: string;
    baselineWorstDrawdownBps: string;
    aiTotalCostsWei: string;
    baselineTotalCostsWei: string;
    modelErrors: number;
    comparatorAverageNetRoiBps: Record<BenchmarkComparator, string>;
    comparatorAverageCompositeScoreBps: Record<BenchmarkComparator, string>;
    aiWinsByComparator: Record<BenchmarkComparator, number>;
    aiCompositeWinsByComparator: Record<BenchmarkComparator, number>;
    modelAssessment: BenchmarkModelAssessmentSummary;
    incrementalValueGate: BenchmarkIncrementalValueGate;
  };
  regimes: BenchmarkRegimeResult[];
}

interface MutableAccount {
  state: VaultState;
  initialPortfolioWei: bigint;
  peakPortfolioWei: bigint;
  maxDrawdownBps: bigint;
  costsPaidWei: bigint;
  turnoverWei: bigint;
  executed: number;
  blocked: number;
  held: number;
  errors: number;
  buys: number;
  sells: number;
  timeline: BenchmarkTickResult[];
}

interface SettlementResult {
  outcome: BenchmarkTickResult["outcome"];
  action: string;
  ruleId: string;
  risk?: RiskResult;
}

function workspaceRoot(cwd = process.cwd()): string {
  return path.basename(cwd) === "agent" ? path.dirname(cwd) : cwd;
}

function loadEnv(cwd = process.cwd()): void {
  const root = workspaceRoot(cwd);
  loadDotenv({ path: path.join(root, ".env") });
  loadDotenv({ path: path.join(root, "agent", ".env") });
}

loadEnv();

function defaultFixturePath(): string {
  return path.join("evals", "market-regimes.json");
}

function defaultOutputPath(): string {
  return process.env.MULTI_REGIME_EVAL_OUTPUT ?? path.join("traces", "multi-regime-benchmark.json");
}

function modelName(liveModel: boolean): string {
  return liveModel
    ? process.env.OPENAI_BENCHMARK_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.2"
    : "regime-routed-ensemble";
}

function parseBps(value: number, label: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} must be an integer from 0 to 10000`);
  }
  return BigInt(value);
}

function parseFixture(fixture: MultiRegimeFixture): ParsedFixture {
  if (fixture.version !== 1) throw new Error(`unsupported market-regime fixture version: ${fixture.version}`);
  if (!fixture.regimes.length) throw new Error("market-regime fixture must contain at least one regime");

  const costs = {
    swapFeeBps: parseBps(fixture.costs.swapFeeBps, "costs.swapFeeBps"),
    slippageBps: parseBps(fixture.costs.slippageBps, "costs.slippageBps"),
    gasWei: parseEther(fixture.costs.gasMnt),
  };
  if (costs.swapFeeBps + costs.slippageBps >= BPS) {
    throw new Error("combined swap fee and slippage must be below 10000 bps");
  }

  return {
    name: fixture.name,
    initialMntWei: parseEther(fixture.initialPortfolio.mnt),
    initialTokenWei: parseEther(fixture.initialPortfolio.token),
    baselineBuyWei: parseEther(fixture.baseline.buyMnt),
    costs,
    spendLimitPerTx: parseEther(fixture.vaultLimits.spendPerTxMnt),
    dailyLimit: parseEther(fixture.vaultLimits.dailySpendMnt),
    regimes: fixture.regimes.map((regime) => {
      if (regime.prices.length < 2) throw new Error(`${regime.id} must contain at least two prices`);
      return {
        id: regime.id,
        label: regime.label,
        description: regime.description,
        pricesWei: regime.prices.map((price) => parseEther(price)),
      };
    }),
  };
}

export async function loadMultiRegimeFixture(filePath = defaultFixturePath()): Promise<MultiRegimeFixture> {
  return JSON.parse(await readFile(filePath, "utf8")) as MultiRegimeFixture;
}

function initialState(fixture: ParsedFixture, priceWei: bigint): VaultState {
  return {
    balanceWei: fixture.initialMntWei,
    spendLimitPerTx: fixture.spendLimitPerTx,
    dailyLimit: fixture.dailyLimit,
    spentToday: 0n,
    windowStart: 1_000n,
    paused: false,
    tokenBalanceWei: fixture.initialTokenWei,
    priceWei,
  };
}

function createAccount(fixture: ParsedFixture, priceWei: bigint): MutableAccount {
  const state = initialState(fixture, priceWei);
  const initialPortfolioWei = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, priceWei);
  return {
    state,
    initialPortfolioWei,
    peakPortfolioWei: initialPortfolioWei,
    maxDrawdownBps: 0n,
    costsPaidWei: 0n,
    turnoverWei: 0n,
    executed: 0,
    blocked: 0,
    held: 0,
    errors: 0,
    buys: 0,
    sells: 0,
    timeline: [],
  };
}

function costAdjustedOutput(grossOutput: bigint, costs: BenchmarkCosts): bigint {
  return (grossOutput * (BPS - costs.swapFeeBps - costs.slippageBps)) / BPS;
}

function executionCostWei(grossValueWei: bigint, costs: BenchmarkCosts): bigint {
  return ((grossValueWei * (costs.swapFeeBps + costs.slippageBps)) / BPS) + costs.gasWei;
}

function settleDecision(
  account: MutableAccount,
  decision: Decision,
  adapter: ProtocolAdapter,
  priceWei: bigint,
  costs: BenchmarkCosts,
  nowSeconds: bigint,
): SettlementResult {
  account.state.priceWei = priceWei;
  if (decision.kind === "hold") {
    account.held += 1;
    return { outcome: "hold", action: "hold", ruleId: "NONE" };
  }

  const risk = evaluateRisk({
    decision,
    state: account.state,
    nowSeconds,
    allowedTargets: [adapter.target],
    allowedSelectors: [...adapter.allowedSelectors],
    oracle: {
      pair: "MNT/MOCK",
      priceWei,
      source: "mockdex",
      updatedAt: nowSeconds,
      stale: false,
      maxAgeSeconds: 300n,
    },
    quotePriceWei: priceWei,
    simulation: { ok: true, gasEstimate: 100_000n },
    limits: DEFAULT_RISK_LIMITS,
  });
  if (!risk.ok) {
    account.blocked += 1;
    return { outcome: "blocked", action: decision.action ?? "execute", ruleId: risk.ruleId, risk };
  }

  if (decision.action === "buy") {
    if (decision.valueWei + costs.gasWei > account.state.balanceWei) {
      account.blocked += 1;
      return {
        outcome: "blocked",
        action: "buy",
        ruleId: "INSUFFICIENT_GAS_RESERVE",
      };
    }
    const grossTokenWei = (decision.valueWei * ONE) / priceWei;
    const netTokenWei = costAdjustedOutput(grossTokenWei, costs);
    account.state.balanceWei -= decision.valueWei + costs.gasWei;
    account.state.tokenBalanceWei += netTokenWei;
    account.state.spentToday += decision.valueWei;
    account.turnoverWei += decision.valueWei;
    account.costsPaidWei += executionCostWei(decision.valueWei, costs);
    account.executed += 1;
    account.buys += 1;
    return { outcome: "executed", action: "buy", ruleId: "NONE", risk };
  }

  if (decision.action === "sell") {
    const amountTokenWei = decision.amountTokenWei ?? 0n;
    const grossMntWei = (amountTokenWei * priceWei) / ONE;
    const netMntWei = costAdjustedOutput(grossMntWei, costs);
    if (account.state.balanceWei + netMntWei < costs.gasWei) {
      account.blocked += 1;
      return {
        outcome: "blocked",
        action: "sell",
        ruleId: "INSUFFICIENT_GAS_RESERVE",
      };
    }
    account.state.tokenBalanceWei -= amountTokenWei;
    account.state.balanceWei += netMntWei - costs.gasWei;
    account.turnoverWei += grossMntWei;
    account.costsPaidWei += executionCostWei(grossMntWei, costs);
    account.executed += 1;
    account.sells += 1;
    return { outcome: "executed", action: "sell", ruleId: "NONE", risk };
  }

  account.blocked += 1;
  return { outcome: "blocked", action: decision.action ?? "execute", ruleId: "UNSUPPORTED_ACTION" };
}

function markAccount(account: MutableAccount, tick: number, priceWei: bigint, decision: Decision, settlement: SettlementResult): void {
  const valueWei = portfolioValueWei(account.state.balanceWei, account.state.tokenBalanceWei, priceWei);
  if (valueWei > account.peakPortfolioWei) account.peakPortfolioWei = valueWei;
  const drawdownBps = roiBps(valueWei, account.peakPortfolioWei);
  if (drawdownBps < account.maxDrawdownBps) account.maxDrawdownBps = drawdownBps;
  const trace = decision.agentTrace ?? {};
  const candidate = trace.candidate as { id?: unknown } | undefined;
  const modelAssessment = trace.modelAssessment as
    | { verdict?: unknown; vetoCode?: unknown; confidence?: unknown }
    | undefined;
  const assessmentValidation = trace.assessmentValidation as
    | { ok?: unknown; reason?: unknown; finalVerdict?: unknown }
    | undefined;
  const modelAssessmentError =
    trace.modelAssessmentError instanceof Error
      ? trace.modelAssessmentError.message
      : typeof trace.modelAssessmentError === "string"
        ? trace.modelAssessmentError
        : trace.modelAssessmentError === undefined
          ? undefined
          : String(trace.modelAssessmentError);
  const assessmentCache = trace.assessmentCache as { status?: unknown; key?: unknown } | undefined;
  const rateLimit = trace.rateLimit as { deferred?: unknown } | undefined;
  account.timeline.push({
    tick,
    priceWei: priceWei.toString(),
    action: settlement.action,
    outcome: settlement.outcome,
    ruleId: settlement.ruleId,
    rationale: decision.rationale,
    analysis: decision.analysis,
    decisionMode: typeof trace.decisionMode === "string" ? trace.decisionMode : undefined,
    candidateId: typeof candidate?.id === "string" ? candidate.id : undefined,
    modelVerdict: typeof modelAssessment?.verdict === "string" ? modelAssessment.verdict : undefined,
    modelVetoCode: typeof modelAssessment?.vetoCode === "string" ? modelAssessment.vetoCode : undefined,
    modelAssessmentConfidence:
      typeof modelAssessment?.confidence === "number" ? modelAssessment.confidence : undefined,
    assessmentFinalVerdict:
      typeof assessmentValidation?.finalVerdict === "string" ? assessmentValidation.finalVerdict : undefined,
    assessmentValidationOk:
      typeof assessmentValidation?.ok === "boolean" ? assessmentValidation.ok : undefined,
    assessmentValidationReason:
      typeof assessmentValidation?.reason === "string" ? assessmentValidation.reason : undefined,
    modelAssessmentError,
    assessmentCacheStatus: typeof assessmentCache?.status === "string" ? assessmentCache.status : undefined,
    assessmentCacheKey: typeof assessmentCache?.key === "string" ? assessmentCache.key : undefined,
    providerRateLimitDeferred: typeof rateLimit?.deferred === "boolean" ? rateLimit.deferred : undefined,
    portfolioValueWei: valueWei.toString(),
    portfolioRoiBps: roiBps(valueWei, account.initialPortfolioWei).toString(),
    cumulativeCostsWei: account.costsPaidWei.toString(),
  });
}

async function buildBaselineDecision(
  account: MutableAccount,
  adapter: ProtocolAdapter,
  amountWei: bigint,
  nowSeconds: bigint,
): Promise<Decision> {
  const normalized = normalizeTradeIntent(
    { action: "buy", amountMntWei: amountWei, rationale: `DCA baseline: fixed ${formatEther(amountWei)} MNT buy` },
    account.state,
    nowSeconds,
  );
  if (normalized.action === "hold") return { kind: "hold", rationale: normalized.rationale };
  const quote = await adapter.quote(normalized);
  return planToDecision(adapter.buildPlan(normalized, quote), normalized.rationale);
}

async function buildIntentDecision(
  account: MutableAccount,
  adapter: ProtocolAdapter,
  intent: TradeIntent | { action: "hold"; rationale: string },
  nowSeconds: bigint,
): Promise<Decision> {
  const normalized = normalizeTradeIntent(intent, account.state, nowSeconds);
  if (normalized.action === "hold") return { kind: "hold", rationale: normalized.rationale };
  const quote = await adapter.quote(normalized);
  return planToDecision(adapter.buildPlan(normalized, quote), normalized.rationale);
}

async function buildComparatorDecision(
  comparator: BenchmarkComparator,
  account: MutableAccount,
  adapter: ProtocolAdapter,
  baselineBuyWei: bigint,
  priceHistory: readonly bigint[],
  costs: BenchmarkCosts,
  tickIndex: number,
  nowSeconds: bigint,
): Promise<Decision> {
  if (comparator === "dca") return buildBaselineDecision(account, adapter, baselineBuyWei, nowSeconds);
  if (comparator === "buy-and-hold") {
    if (tickIndex !== 0) return { kind: "hold", rationale: "Buy-and-hold comparator keeps the initial entry." };
    return buildIntentDecision(
      account,
      adapter,
      {
        action: "buy",
        amountMntWei: account.state.spendLimitPerTx,
        rationale: "Buy-and-hold comparator bought the maximum single risk-approved starter position.",
      },
      nowSeconds,
    );
  }
  if (comparator === "deterministic-ensemble") {
    return buildStrategyDecision({
      regimeId: "deterministic-ensemble",
      tickIndex,
      state: { ...account.state },
      priceHistory: [...priceHistory],
      adapter,
      costs,
      baselineBuyWei,
    });
  }
  if (comparator === "hold") return { kind: "hold", rationale: "Always-hold comparator." };
  if (priceHistory.length < 2) return { kind: "hold", rationale: `${comparator} comparator needs more history.` };

  const current = priceHistory[priceHistory.length - 1];
  if (comparator === "momentum") {
    const previous = priceHistory[priceHistory.length - 2];
    if (current * BPS > previous * 10_050n) {
      return buildIntentDecision(
        account,
        adapter,
        { action: "buy", amountMntWei: baselineBuyWei, rationale: "Momentum comparator bought positive continuation." },
        nowSeconds,
      );
    }
    if (current * BPS < previous * 9_950n && account.state.tokenBalanceWei > 0n) {
      return buildIntentDecision(
        account,
        adapter,
        {
          action: "sell",
          amountTokenWei: account.state.tokenBalanceWei / 5n,
          rationale: "Momentum comparator reduced exposure on negative continuation.",
        },
        nowSeconds,
      );
    }
    return { kind: "hold", rationale: "Momentum comparator found no continuation signal." };
  }

  const priorAverage = average(priceHistory.slice(0, -1));
  if (current * 100n < priorAverage * 99n) {
    return buildIntentDecision(
      account,
      adapter,
      { action: "buy", amountMntWei: baselineBuyWei, rationale: "Mean-reversion comparator bought below average." },
      nowSeconds,
    );
  }
  if (current * 100n > priorAverage * 101n && account.state.tokenBalanceWei > 0n) {
    return buildIntentDecision(
      account,
      adapter,
      {
        action: "sell",
        amountTokenWei: (account.state.tokenBalanceWei * 4n) / 10n,
        rationale: "Mean-reversion comparator sold above average.",
      },
      nowSeconds,
    );
  }
  return { kind: "hold", rationale: "Mean-reversion comparator found no range deviation." };
}

function scoreRunnerMetrics(
  netRoi: bigint,
  grossRoi: bigint,
  maxDrawdownBps: bigint,
  blocked: number,
  errors: number,
): BenchmarkRunnerScore {
  const transactionCostPenaltyBps = grossRoi - netRoi;
  const drawdownPenaltyBps = maxDrawdownBps < 0n ? (-maxDrawdownBps) / 2n : 0n;
  const blockedPenaltyBps = BigInt(blocked * 25);
  const errorPenaltyBps = BigInt(errors * 100);
  const compositeScoreBps =
    netRoi -
    drawdownPenaltyBps -
    transactionCostPenaltyBps -
    blockedPenaltyBps -
    errorPenaltyBps;
  return {
    netRoiBps: netRoi.toString(),
    drawdownPenaltyBps: drawdownPenaltyBps.toString(),
    transactionCostPenaltyBps: transactionCostPenaltyBps.toString(),
    blockedPenaltyBps: blockedPenaltyBps.toString(),
    errorPenaltyBps: errorPenaltyBps.toString(),
    compositeScoreBps: compositeScoreBps.toString(),
  };
}

function finalizeRunner(
  runner: "ai" | BenchmarkComparator,
  account: MutableAccount,
  finalPriceWei: bigint,
): BenchmarkRunnerResult {
  const netPortfolioValueWei = portfolioValueWei(account.state.balanceWei, account.state.tokenBalanceWei, finalPriceWei);
  const grossPortfolioValueWei = netPortfolioValueWei + account.costsPaidWei;
  const grossRoi = roiBps(grossPortfolioValueWei, account.initialPortfolioWei);
  const netRoi = roiBps(netPortfolioValueWei, account.initialPortfolioWei);
  const score = scoreRunnerMetrics(netRoi, grossRoi, account.maxDrawdownBps, account.blocked, account.errors);
  return {
    runner,
    ticks: account.timeline.length,
    executed: account.executed,
    blocked: account.blocked,
    held: account.held,
    errors: account.errors,
    buys: account.buys,
    sells: account.sells,
    turnoverWei: account.turnoverWei.toString(),
    totalCostsWei: account.costsPaidWei.toString(),
    grossPortfolioValueWei: grossPortfolioValueWei.toString(),
    netPortfolioValueWei: netPortfolioValueWei.toString(),
    grossRoiBps: grossRoi.toString(),
    netRoiBps: netRoi.toString(),
    transactionCostDragBps: (grossRoi - netRoi).toString(),
    maxDrawdownBps: account.maxDrawdownBps.toString(),
    score,
    timeline: account.timeline,
  };
}

async function runRegime(
  fixture: ParsedFixture,
  regime: ParsedFixture["regimes"][number],
  decisionRunner: BenchmarkDecisionRunner,
): Promise<BenchmarkRegimeResult> {
  let currentPrice = regime.pricesWei[0];
  const adapter = createMockDexAdapter(DEX, TOKEN, async () => currentPrice);
  const ai = createAccount(fixture, currentPrice);
  const comparatorAccounts = Object.fromEntries(
    COMPARATOR_NAMES.map((name) => [name, createAccount(fixture, currentPrice)]),
  ) as Record<BenchmarkComparator, MutableAccount>;
  const priceHistory: bigint[] = [];

  for (let tick = 0; tick < regime.pricesWei.length; tick += 1) {
    currentPrice = regime.pricesWei[tick];
    priceHistory.push(currentPrice);
    if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
    ai.state.priceWei = currentPrice;
    for (const account of Object.values(comparatorAccounts)) account.state.priceWei = currentPrice;
    const nowSeconds = 1_000n + BigInt(tick);

    let aiDecision: Decision;
    let aiSettlement: SettlementResult;
    try {
      aiDecision = await decisionRunner({
        regimeId: regime.id,
        tickIndex: tick,
        state: { ...ai.state },
        priceHistory: [...priceHistory],
        adapter,
        costs: fixture.costs,
        baselineBuyWei: fixture.baselineBuyWei,
      });
      aiSettlement = settleDecision(ai, aiDecision, adapter, currentPrice, fixture.costs, nowSeconds);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
      const message = status === 429 ? "OpenAI rate limit exceeded after benchmark retries." : error instanceof Error ? error.message : String(error);
      ai.errors += 1;
      aiDecision = { kind: "hold", rationale: `Model error: ${message}` };
      aiSettlement = { outcome: "error", action: "hold", ruleId: "MODEL_ERROR" };
    }
    markAccount(ai, tick, currentPrice, aiDecision, aiSettlement);

    for (const comparator of COMPARATOR_NAMES) {
      const account = comparatorAccounts[comparator];
      const decision = await buildComparatorDecision(
        comparator,
        account,
        adapter,
        fixture.baselineBuyWei,
        priceHistory,
        fixture.costs,
        tick,
        nowSeconds,
      );
      const settlement = settleDecision(account, decision, adapter, currentPrice, fixture.costs, nowSeconds);
      markAccount(account, tick, currentPrice, decision, settlement);
    }
  }

  const finalPriceWei = regime.pricesWei[regime.pricesWei.length - 1];
  const aiResult = finalizeRunner("ai", ai, finalPriceWei);
  const comparators = Object.fromEntries(
    COMPARATOR_NAMES.map((name) => [name, finalizeRunner(name, comparatorAccounts[name], finalPriceWei)]),
  ) as Record<BenchmarkComparator, BenchmarkRunnerResult>;
  const baselineResult = comparators.dca;
  const aiRoi = BigInt(aiResult.netRoiBps);
  const baselineRoi = BigInt(baselineResult.netRoiBps);
  return {
    id: regime.id,
    label: regime.label,
    description: regime.description,
    priceStartWei: regime.pricesWei[0].toString(),
    priceEndWei: finalPriceWei.toString(),
    winner: aiRoi > baselineRoi ? "ai" : baselineRoi > aiRoi ? "baseline" : "tie",
    aiEdgeBps: (aiRoi - baselineRoi).toString(),
    ai: aiResult,
    baseline: baselineResult,
    comparators,
  };
}

function average(values: bigint[]): bigint {
  if (!values.length) return 0n;
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

function minimum(values: bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

function percentageBps(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0";
  return ((BigInt(numerator) * BPS) / BigInt(denominator)).toString();
}

function summarizeModelAssessment(regimes: readonly BenchmarkRegimeResult[]): BenchmarkModelAssessmentSummary {
  const ticks = regimes.flatMap((regime) => regime.ai.timeline);
  const candidateEvents = ticks.filter((tick) => tick.candidateId && tick.decisionMode === "candidate_assessment");
  const assessed = candidateEvents.filter((tick) => tick.modelVerdict === "approve" || tick.modelVerdict === "veto");
  const approvals = assessed.filter((tick) => tick.modelVerdict === "approve");
  const vetoes = assessed.filter((tick) => tick.modelVerdict === "veto");
  const validVetoes = assessed.filter((tick) => tick.assessmentFinalVerdict === "vetoed");
  const invalidVetoesIgnored = assessed.filter((tick) => tick.assessmentFinalVerdict === "invalid_veto_ignored");
  const invalidApprovalsLogged = assessed.filter((tick) => tick.assessmentFinalVerdict === "invalid_approval_logged");
  const assessmentErrors = assessed.filter((tick) => tick.modelAssessmentError).length;
  const stateGroundingErrors = assessed.filter((tick) =>
    tick.assessmentValidationReason?.includes("POSITION_HALLUCINATION"),
  ).length;
  const approvedExecutions = approvals.filter((tick) => tick.outcome === "executed").length;
  const providerRateLimitSkips = candidateEvents.filter((tick) => tick.providerRateLimitDeferred).length;
  const assessmentBudgetSkips = candidateEvents.filter((tick) => tick.modelAssessmentError === "assessment_budget_exhausted").length;
  const cacheHits = assessed.filter((tick) => tick.assessmentCacheStatus === "hit").length;
  const cacheMisses = assessed.filter((tick) => tick.assessmentCacheStatus === "miss").length;

  return {
    candidateEvents: candidateEvents.length,
    candidatesAssessed: assessed.length,
    approvals: approvals.length,
    vetoes: vetoes.length,
    validVetoes: validVetoes.length,
    invalidVetoesIgnored: invalidVetoesIgnored.length,
    invalidApprovalsLogged: invalidApprovalsLogged.length,
    assessmentErrors,
    stateGroundingErrors,
    approvedExecutions,
    approvalPrecisionBps: percentageBps(approvedExecutions, approvals.length),
    suppressedFeasibleCandidates: validVetoes.length,
    providerRateLimitSkips,
    assessmentBudgetSkips,
    cacheHits,
    cacheMisses,
  };
}

function incrementalValueGate(
  regimes: readonly BenchmarkRegimeResult[],
  aiAverageCompositeScore: bigint,
  aiAverageNetRoi: bigint,
  aiWorstDrawdown: bigint,
): BenchmarkIncrementalValueGate {
  const comparator = "deterministic-ensemble" as const;
  const comparatorComposite = average(
    regimes.map((regime) => BigInt(regime.comparators[comparator].score.compositeScoreBps)),
  );
  const comparatorNetRoi = average(regimes.map((regime) => BigInt(regime.comparators[comparator].netRoiBps)));
  const comparatorWorstDrawdown = minimum(regimes.map((regime) => BigInt(regime.comparators[comparator].maxDrawdownBps)));
  const compositeEdge = aiAverageCompositeScore - comparatorComposite;
  const netRoiEdge = aiAverageNetRoi - comparatorNetRoi;
  const drawdownImprovement = aiWorstDrawdown - comparatorWorstDrawdown;
  const improvedComposite = compositeEdge > 0n;
  const saferWithoutMaterialReturnLoss = netRoiEdge >= -10n && drawdownImprovement >= 25n;
  const passed = improvedComposite || saferWithoutMaterialReturnLoss;
  return {
    comparator,
    passed,
    reason: improvedComposite
      ? "AI-assisted model layer improved average composite score over deterministic ensemble."
      : saferWithoutMaterialReturnLoss
        ? "AI-assisted model layer preserved return within 10 bps while improving worst drawdown by at least 25 bps."
        : "AI-assisted model layer did not beat deterministic ensemble on composite score or the safer-no-material-return-loss gate.",
    aiAverageCompositeScoreBps: aiAverageCompositeScore.toString(),
    comparatorAverageCompositeScoreBps: comparatorComposite.toString(),
    compositeEdgeBps: compositeEdge.toString(),
    aiAverageNetRoiBps: aiAverageNetRoi.toString(),
    comparatorAverageNetRoiBps: comparatorNetRoi.toString(),
    netRoiEdgeBps: netRoiEdge.toString(),
    aiWorstDrawdownBps: aiWorstDrawdown.toString(),
    comparatorWorstDrawdownBps: comparatorWorstDrawdown.toString(),
    drawdownImprovementBps: drawdownImprovement.toString(),
  };
}

function strategyTradeIntent(intent: StrategyIntent): TradeIntent | { action: "hold"; rationale: string } {
  if (intent.action === "hold") return { action: "hold", rationale: intent.rationale };
  if (intent.action === "buy") {
    return {
      action: "buy",
      amountMntWei: intent.amountMntWei,
      rationale: intent.rationale,
    };
  }
  return {
    action: "sell",
    amountTokenWei: intent.amountTokenWei,
    rationale: intent.rationale,
  };
}

function estimatedCostBps(costs: BenchmarkCosts, baselineBuyWei: bigint): number {
  const feeAndSlippage = costs.swapFeeBps + costs.slippageBps;
  const gasBps = baselineBuyWei > 0n ? (costs.gasWei * BPS) / baselineBuyWei : 0n;
  return Number(feeAndSlippage + gasBps);
}

interface CandidateAssessmentCacheEntry {
  candidateId: string;
  model: string;
  fingerprint: string;
  argumentsJson: string;
  cachedAt: string;
}

interface CandidateAssessmentCacheFile {
  version: 1;
  entries: Record<string, CandidateAssessmentCacheEntry>;
}

interface CandidateAssessmentCacheLookup {
  status: "hit" | "miss";
  key: string;
  path?: string;
}

class AssessmentBudgetExceeded extends Error {
  constructor() {
    super("assessment_budget_exhausted");
  }
}

class CandidateAssessmentCacheStore {
  private readonly enabled: boolean;
  private readonly filePath?: string;
  private readonly file: CandidateAssessmentCacheFile;

  constructor(options: { enabled: boolean; filePath?: string }) {
    this.enabled = options.enabled;
    this.filePath = options.filePath;
    this.file = { version: 1, entries: {} };
    if (!this.enabled || !this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as CandidateAssessmentCacheFile;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        this.file = parsed;
      }
    } catch {
      this.file = { version: 1, entries: {} };
    }
  }

  get(key: string): CandidateAssessmentCacheEntry | undefined {
    return this.enabled ? this.file.entries[key] : undefined;
  }

  set(key: string, entry: CandidateAssessmentCacheEntry): void {
    if (!this.enabled || !this.filePath) return;
    this.file.entries[key] = entry;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
  }

  lookup(status: "hit" | "miss", key: string): CandidateAssessmentCacheLookup | undefined {
    if (!this.enabled) return undefined;
    return { status, key, path: this.filePath };
  }
}

function defaultCandidateAssessmentCachePath(): string {
  return process.env.OPENAI_CANDIDATE_ASSESSMENT_CACHE_PATH ?? path.join("traces", "openai-candidate-assessment-cache.json");
}

function optionalPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateAssessmentSystemPrompt(state: VaultState): string {
  return (
    "You are an OpenAI DeFi candidate critic for a synchronized benchmark. " +
    "The deterministic strategy has already selected exactly one trade candidate and fixed its action, amount, edge, and regime. " +
    "Approve the candidate or veto it with a supported veto code. Do not propose a different action or amount. " +
    "Veto only for state_inconsistency, regime_conflict, evidence_insufficient, or tail_risk. " +
    "If tokenBalance is 0, holding preserves cash, not a winning token position. " +
    `Current balances: mntBalance=${formatEther(state.balanceWei)} MNT, tokenBalance=${formatEther(state.tokenBalanceWei)} tokens, ` +
    `price=${formatEther(state.priceWei)} MNT/token, paused=${state.paused}.`
  );
}

function candidateAssessmentUserPrompt(
  context: string,
  priceHistory: readonly bigint[],
  features: ReturnType<typeof computeMarketFeatures>,
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

async function requestCandidateAssessment(
  input: {
    client: ReasoningClient;
    model: string;
    context: string;
    state: VaultState;
    priceHistory: readonly bigint[];
    features: ReturnType<typeof computeMarketFeatures>;
    candidate: TradeCandidate;
    cache: CandidateAssessmentCacheStore;
    beforeApiCall: () => Promise<void>;
  },
): Promise<{ argumentsJson: string; cache?: CandidateAssessmentCacheLookup; apiCalled: boolean }> {
  if (input.client.provider !== "openai" || !input.client.openai) throw new Error("OpenAI client missing");
  const systemPrompt = candidateAssessmentSystemPrompt(input.state);
  const userPrompt = candidateAssessmentUserPrompt(input.context, input.priceHistory, input.features, input.candidate);
  const fingerprint = sha256(JSON.stringify({ model: input.model, systemPrompt, userPrompt, tool: ASSESS_CANDIDATE_TOOL.name }));
  const key = `${input.model}:${input.candidate.id}:${fingerprint.slice(0, 24)}`;
  const cached = input.cache.get(key);
  if (cached) {
    return { argumentsJson: cached.argumentsJson, cache: input.cache.lookup("hit", key), apiCalled: false };
  }

  await input.beforeApiCall();
  const response = await input.client.openai.responses.create({
    model: input.model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
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
  if (!toolCall) throw new Error("OpenAI did not return assess_trade_candidate");
  const argumentsJson = String(toolCall.arguments ?? "{}");
  input.cache.set(key, {
    candidateId: input.candidate.id,
    model: input.model,
    fingerprint,
    argumentsJson,
    cachedAt: new Date().toISOString(),
  });
  return { argumentsJson, cache: input.cache.lookup("miss", key), apiCalled: true };
}

async function buildStrategyDecision(
  input: BenchmarkDecisionInput,
  strategy: StrategyFunction = (strategyInput) => regimeRoutedEnsemble(strategyInput, loadEnsembleConfigFromEnv()),
): Promise<Decision> {
  const features = computeMarketFeatures(input.priceHistory);
  const strategyIntent = strategy({
    priceHistory: input.priceHistory,
    features,
    state: input.state,
    baselineBuyWei: input.baselineBuyWei,
    estimatedExecutionCostBps: estimatedCostBps(input.costs, input.baselineBuyWei),
  });
  const normalized = normalizeTradeIntent(
    strategyTradeIntent(strategyIntent),
    input.state,
    1_000n + BigInt(input.tickIndex),
  );
  const analysis = {
    regime: features.regime,
    confidence: features.confidence,
    expectedEdgeBps: strategyIntent.expectedEdgeBps,
    sizePercent: normalized.action === "hold" ? 0 : strategyIntent.sizePercent,
    invalidationCondition: "The deterministic regime classification or cost-adjusted edge changes.",
    marketFeatures: features,
  };
  if (normalized.action === "hold") return { kind: "hold", rationale: normalized.rationale, analysis };
  const quote = await input.adapter.quote(normalized);
  return { ...planToDecision(input.adapter.buildPlan(normalized, quote), normalized.rationale), analysis };
}

export function createOfflineBenchmarkDecisionRunner(
  strategy: StrategyFunction = (input) => regimeRoutedEnsemble(input, loadEnsembleConfigFromEnv()),
): BenchmarkDecisionRunner {
  return (input) => buildStrategyDecision(input, strategy);
}

export function createAiAssistedBenchmarkDecisionRunner(
  strategy: StrategyFunction = (input) => regimeRoutedEnsemble(input, loadEnsembleConfigFromEnv()),
): BenchmarkDecisionRunner {
  return async ({ tickIndex, state, priceHistory, adapter, costs, baselineBuyWei }) => {
    const features = computeMarketFeatures(priceHistory);
    const candidateResult = buildCandidateFromStrategy(
      state,
      priceHistory,
      features,
      {
        strategyPrior: strategy,
        strategyBaselineBuyWei: baselineBuyWei,
        estimatedExecutionCostBps: estimatedCostBps(costs, baselineBuyWei),
        feeBps: Number(costs.swapFeeBps),
        slippageBps: Number(costs.slippageBps),
      },
      1_000n + BigInt(tickIndex),
    );

    if (candidateResult.hold || !candidateResult.candidate) {
      return candidateResult.hold ?? { kind: "hold", rationale: candidateResult.reason, analysis: candidateResult.analysis };
    }

    const assessment: CandidateAssessment = {
      candidateId: candidateResult.candidate.id,
      verdict: "approve",
      vetoCode: "none",
      confidence: candidateResult.candidate.confidence,
      evidence: [
        "Synchronized benchmark approval fixture: candidate came from the deterministic ensemble.",
        ...candidateResult.candidate.evidence,
      ],
      rationale: "Approved because the candidate passed deterministic strategy, normalization, and cost pre-gates.",
    };

    return buildDecisionFromCandidateAssessment(
      candidateResult.candidate,
      assessment,
      adapter,
      state,
      candidateResult.analysis,
      {
        benchmarkMode: "synchronized_ai_assisted",
        candidateGate: {
          reason: candidateResult.reason,
          economicGate: candidateResult.economicGate,
        },
      },
    );
  };
}

export interface OpenAiCandidateAssessmentBenchmarkOptions {
  client?: ReasoningClient;
  model?: string;
  strategy?: StrategyFunction;
  maxRetries?: number;
  minimumIntervalMs?: number;
  cacheEnabled?: boolean;
  cachePath?: string;
  deferRateLimit?: boolean;
  maxAssessmentsPerRegime?: number;
}

export function createOpenAiCandidateAssessmentBenchmarkDecisionRunner(
  options: OpenAiCandidateAssessmentBenchmarkOptions = {},
): BenchmarkDecisionRunner {
  if (!options.client && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required for the live candidate-assessment benchmark");
  }
  const model = options.model ?? modelName(true);
  const client: ReasoningClient = options.client ?? { provider: "openai", openai: new OpenAI({ maxRetries: 0 }) };
  const strategy = options.strategy ?? ((input) => regimeRoutedEnsemble(input, loadEnsembleConfigFromEnv()));
  const maxRetries = options.maxRetries ?? Number(process.env.OPENAI_BENCHMARK_MAX_RETRIES ?? "8");
  const minimumIntervalMs =
    options.minimumIntervalMs ??
    Number(
      process.env.OPENAI_CANDIDATE_ASSESSMENT_MIN_INTERVAL_MS ??
        process.env.OPENAI_BENCHMARK_MIN_INTERVAL_MS ??
        (model === "gpt-5.2" ? "65000" : "0"),
    );
  const cacheEnabled =
    options.cacheEnabled ??
    ((process.env.OPENAI_CANDIDATE_ASSESSMENT_CACHE ?? "1") !== "0" && (!options.client || Boolean(options.cachePath)));
  const cache = new CandidateAssessmentCacheStore({
    enabled: cacheEnabled,
    filePath: cacheEnabled ? options.cachePath ?? defaultCandidateAssessmentCachePath() : undefined,
  });
  const deferRateLimit =
    options.deferRateLimit ?? (process.env.OPENAI_CANDIDATE_ASSESSMENT_DEFER_RATE_LIMIT ?? "1") !== "0";
  const maxAssessmentsPerRegime =
    options.maxAssessmentsPerRegime ?? optionalPositiveInteger(process.env.OPENAI_CANDIDATE_ASSESSMENT_MAX_PER_REGIME);
  const assessmentsByRegime = new Map<string, number>();
  let nextRequestAt = 0;

  return async ({ regimeId, tickIndex, state, priceHistory, adapter, costs, baselineBuyWei }) => {
    if (priceHistory.length < 2) {
      return { kind: "hold", rationale: "Need at least two observed prices before requesting a model assessment." };
    }
    const nowSeconds = 1_000n + BigInt(tickIndex);
    const features = computeMarketFeatures(priceHistory);
    const candidateResult = buildCandidateFromStrategy(
      state,
      priceHistory,
      features,
      {
        strategyPrior: strategy,
        strategyBaselineBuyWei: baselineBuyWei,
        estimatedExecutionCostBps: estimatedCostBps(costs, baselineBuyWei),
        feeBps: Number(costs.swapFeeBps),
        slippageBps: Number(costs.slippageBps),
        preModelGasEstimateUnits: 170_000n,
        preModelGasPriceWei: costs.gasWei / 170_000n,
      },
      nowSeconds,
    );
    if (candidateResult.hold || !candidateResult.candidate) {
      return candidateResult.hold ?? { kind: "hold", rationale: candidateResult.reason, analysis: candidateResult.analysis };
    }
    const traceBase = {
      benchmarkMode: "live_candidate_assessment",
      decisionMode: "candidate_assessment",
      candidate: candidateResult.candidate,
      strategyIntent: candidateResult.strategyIntent,
      candidateGate: { reason: candidateResult.reason, economicGate: candidateResult.economicGate },
    };
    const holdForAssessmentFailure = (
      rationale: string,
      modelAssessmentError: string,
      extraTrace: Record<string, unknown> = {},
    ): Decision => ({
      kind: "hold",
      rationale,
      analysis: candidateResult.analysis,
      agentTrace: {
        ...traceBase,
        modelAssessmentError,
        ...extraTrace,
      },
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const context = `This is a synchronized, no-chain-write benchmark. Assess only the supplied deterministic candidate. Each execution pays ${
            costs.swapFeeBps + costs.slippageBps
          } bps in fee/slippage plus ${formatEther(costs.gasWei)} MNT gas.`;
        const assessmentResponse = await requestCandidateAssessment({
          client,
          model,
          context,
          state,
          priceHistory,
          features,
          candidate: candidateResult.candidate,
          cache,
          beforeApiCall: async () => {
            const used = assessmentsByRegime.get(regimeId) ?? 0;
            if (maxAssessmentsPerRegime !== undefined && used >= maxAssessmentsPerRegime) {
              throw new AssessmentBudgetExceeded();
            }
            const pacingDelay = Math.max(0, nextRequestAt - Date.now());
            if (pacingDelay) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
            nextRequestAt = Date.now() + minimumIntervalMs;
          },
        });
        if (assessmentResponse.apiCalled) {
          assessmentsByRegime.set(regimeId, (assessmentsByRegime.get(regimeId) ?? 0) + 1);
        }
        let assessment: CandidateAssessment;
        try {
          assessment = parseCandidateAssessment(JSON.parse(assessmentResponse.argumentsJson));
        } catch (error) {
          return holdForAssessmentFailure(
            `OpenAI candidate assessment was invalid; held instead of executing: ${(error as Error).message}`,
            (error as Error).message,
            { assessmentCache: assessmentResponse.cache },
          );
        }
        const decision = await buildDecisionFromCandidateAssessment(
          candidateResult.candidate,
          assessment,
          adapter,
          state,
          candidateResult.analysis,
          {
            ...traceBase,
            assessmentCache: assessmentResponse.cache,
          },
        );
        const action = decision.kind === "execute" ? decision.action : "hold";
        console.error(
          `[candidate-assessment] ${regimeId} tick ${tickIndex + 1}: ${decision.kind} ${action}${
            assessmentResponse.cache ? ` cache=${assessmentResponse.cache.status}` : ""
          }`,
        );
        return decision;
      } catch (error) {
        if (error instanceof AssessmentBudgetExceeded) {
          return holdForAssessmentFailure(
            "OpenAI candidate assessment budget exhausted for this regime; held without scoring it as a model error.",
            "assessment_budget_exhausted",
            { assessmentBudget: { maxAssessmentsPerRegime } },
          );
        }
        const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
        if (status !== 429) throw error;
        if (attempt >= maxRetries && deferRateLimit) {
          return holdForAssessmentFailure(
            "OpenAI rate limit deferred this candidate assessment; held without scoring provider throttling as strategy failure.",
            "provider_rate_limit",
            { rateLimit: { attempts: attempt + 1, deferred: true } },
          );
        }
        if (attempt >= maxRetries) throw error;
        const delayMs = rateLimitDelayMs(error, attempt);
        console.error(
          `[candidate-assessment] ${regimeId} tick ${tickIndex + 1}: rate limited, retrying in ${Math.ceil(
            delayMs / 1_000,
          )}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}

export function createOpenAiBenchmarkDecisionRunner(): BenchmarkDecisionRunner {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for the live multi-regime benchmark");
  const model = modelName(true);
  const client: ReasoningClient = { provider: "openai", openai: new OpenAI({ maxRetries: 0 }) };
  const maxRetries = Number(process.env.OPENAI_BENCHMARK_MAX_RETRIES ?? "8");
  const minimumIntervalMs = Number(
    process.env.OPENAI_BENCHMARK_MIN_INTERVAL_MS ?? (model === "gpt-5.2" ? "21000" : "0"),
  );
  let nextRequestAt = 0;
  return async ({ regimeId, tickIndex, state, priceHistory, adapter, costs }) => {
    if (priceHistory.length < 2) {
      return { kind: "hold", rationale: "Need at least two observed prices before requesting a model decision." };
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const pacingDelay = Math.max(0, nextRequestAt - Date.now());
        if (pacingDelay) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
        nextRequestAt = Date.now() + minimumIntervalMs;
        const decision = await decide(
          client,
          state,
          priceHistory,
          adapter,
          `This is an offline, no-chain-write benchmark. Use only observed prices. Each execution pays ${
            costs.swapFeeBps + costs.slippageBps
          } bps in fee/slippage plus ${formatEther(costs.gasWei)} MNT gas, so avoid low-conviction turnover.`,
          {
            openAiModel: model,
            estimatedExecutionCostBps:
              Number(costs.swapFeeBps + costs.slippageBps) +
              Number((costs.gasWei * BPS) / (3n * 10n ** 16n)),
          },
        );
        console.error(`[multi-regime] ${regimeId} tick ${tickIndex + 1}: ${decision.kind}`);
        return decision;
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
        if (status !== 429 || attempt >= maxRetries) throw error;
        const delayMs = rateLimitDelayMs(error, attempt);
        console.error(
          `[multi-regime] ${regimeId} tick ${tickIndex + 1}: rate limited, retrying in ${Math.ceil(delayMs / 1_000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}

export function rateLimitDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/try again in\s+([\d.]+)\s*(ms|s)/i);
  if (match) {
    const value = Number(match[1]);
    const milliseconds = match[2].toLowerCase() === "ms" ? value : value * 1_000;
    return Math.max(500, Math.ceil(milliseconds + 500));
  }
  const headers = typeof error === "object" && error && "headers" in error ? (error as any).headers : undefined;
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.max(500, Number(retryAfter) * 1_000 + 500);
  const requestReset = headers?.get?.("x-ratelimit-reset-requests");
  const requestResetMatch = typeof requestReset === "string" ? requestReset.match(/^([\d.]+)(ms|s)$/i) : undefined;
  if (requestResetMatch) {
    const value = Number(requestResetMatch[1]);
    return Math.ceil((requestResetMatch[2].toLowerCase() === "ms" ? value : value * 1_000) + 1_000);
  }
  // A full-window cooldown prevents rejected attempts from continuously occupying a low-RPM bucket.
  return Math.max(65_000, Math.min(120_000, 1_000 * 2 ** Math.min(attempt, 7)));
}

export async function runMultiRegimeBenchmark(
  fixtureInput: MultiRegimeFixture,
  decisionRunner: BenchmarkDecisionRunner,
  options: { fixturePath?: string; liveModel?: boolean; model?: string } = {},
): Promise<MultiRegimeBenchmarkReport> {
  const fixture = parseFixture(fixtureInput);
  const regimes: BenchmarkRegimeResult[] = [];
  for (const regime of fixture.regimes) regimes.push(await runRegime(fixture, regime, decisionRunner));

  const aiRois = regimes.map((regime) => BigInt(regime.ai.netRoiBps));
  const baselineRois = regimes.map((regime) => BigInt(regime.baseline.netRoiBps));
  const aiEdges = regimes.map((regime) => BigInt(regime.aiEdgeBps));
  const aiCompositeScores = regimes.map((regime) => BigInt(regime.ai.score.compositeScoreBps));
  const baselineCompositeScores = regimes.map((regime) => BigInt(regime.baseline.score.compositeScoreBps));
  const buyAndHoldEdges = regimes.map(
    (regime) => BigInt(regime.ai.netRoiBps) - BigInt(regime.comparators["buy-and-hold"].netRoiBps),
  );
  const aiDrawdowns = regimes.map((regime) => BigInt(regime.ai.maxDrawdownBps));
  const baselineDrawdowns = regimes.map((regime) => BigInt(regime.baseline.maxDrawdownBps));
  const modelErrors = regimes.reduce((total, regime) => total + regime.ai.errors, 0);
  const aiAverageNetRoi = average(aiRois);
  const baselineAverageNetRoi = average(baselineRois);
  const aiAverageCompositeScore = average(aiCompositeScores);
  const baselineAverageCompositeScore = average(baselineCompositeScores);
  const aiWorstDrawdown = minimum(aiDrawdowns);
  const baselineWorstDrawdown = minimum(baselineDrawdowns);
  const liveModel = options.liveModel ?? false;
  return {
    ok: modelErrors === 0,
    mode: "multi-regime-benchmark",
    fixture: options.fixturePath ?? fixture.name,
    model: options.model ?? modelName(liveModel),
    liveModel,
    generatedAt: new Date().toISOString(),
    assumptions: {
      swapFeeBps: fixture.costs.swapFeeBps.toString(),
      slippageBps: fixture.costs.slippageBps.toString(),
      gasWeiPerExecution: fixture.costs.gasWei.toString(),
      baselineBuyWei: fixture.baselineBuyWei.toString(),
    },
    aggregate: {
      regimes: regimes.length,
      aiWins: regimes.filter((regime) => regime.winner === "ai").length,
      baselineWins: regimes.filter((regime) => regime.winner === "baseline").length,
      ties: regimes.filter((regime) => regime.winner === "tie").length,
      aiAverageNetRoiBps: aiAverageNetRoi.toString(),
      baselineAverageNetRoiBps: baselineAverageNetRoi.toString(),
      aiAverageEdgeBps: average(aiEdges).toString(),
      aiAverageCompositeScoreBps: aiAverageCompositeScore.toString(),
      baselineAverageCompositeScoreBps: baselineAverageCompositeScore.toString(),
      aiAverageEdgeVsBuyAndHoldBps: average(buyAndHoldEdges).toString(),
      aiWorstDrawdownBps: aiWorstDrawdown.toString(),
      baselineWorstDrawdownBps: baselineWorstDrawdown.toString(),
      aiTotalCostsWei: regimes
        .reduce((total, regime) => total + BigInt(regime.ai.totalCostsWei), 0n)
        .toString(),
      baselineTotalCostsWei: regimes
        .reduce((total, regime) => total + BigInt(regime.baseline.totalCostsWei), 0n)
        .toString(),
      modelErrors,
      comparatorAverageNetRoiBps: Object.fromEntries(
        COMPARATOR_NAMES.map((comparator) => [
          comparator,
          average(regimes.map((regime) => BigInt(regime.comparators[comparator].netRoiBps))).toString(),
        ]),
      ) as Record<BenchmarkComparator, string>,
      comparatorAverageCompositeScoreBps: Object.fromEntries(
        COMPARATOR_NAMES.map((comparator) => [
          comparator,
          average(regimes.map((regime) => BigInt(regime.comparators[comparator].score.compositeScoreBps))).toString(),
        ]),
      ) as Record<BenchmarkComparator, string>,
      aiWinsByComparator: Object.fromEntries(
        COMPARATOR_NAMES.map((comparator) => [
          comparator,
          regimes.filter(
            (regime) => BigInt(regime.ai.netRoiBps) > BigInt(regime.comparators[comparator].netRoiBps),
          ).length,
        ]),
      ) as Record<BenchmarkComparator, number>,
      aiCompositeWinsByComparator: Object.fromEntries(
        COMPARATOR_NAMES.map((comparator) => [
          comparator,
          regimes.filter(
            (regime) =>
              BigInt(regime.ai.score.compositeScoreBps) >
              BigInt(regime.comparators[comparator].score.compositeScoreBps),
          ).length,
        ]),
      ) as Record<BenchmarkComparator, number>,
      modelAssessment: summarizeModelAssessment(regimes),
      incrementalValueGate: incrementalValueGate(regimes, aiAverageCompositeScore, aiAverageNetRoi, aiWorstDrawdown),
    },
    regimes,
  };
}

export async function writeMultiRegimeBenchmark(
  report: MultiRegimeBenchmarkReport,
  outputPath = defaultOutputPath(),
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const aiAssisted = args.includes("--ai-assisted");
  const liveAssessment = args.includes("--live-assessment");
  const summaryOnly = args.includes("--summary");
  const positional = args.filter(
    (arg) => arg !== "--offline" && arg !== "--ai-assisted" && arg !== "--live-assessment" && arg !== "--summary",
  );
  const fixturePath = positional[0] ?? defaultFixturePath();
  const outputPath = positional[1] ?? defaultOutputPath();
  const fixture = await loadMultiRegimeFixture(fixturePath);
  const decisionRunner = liveAssessment
    ? createOpenAiCandidateAssessmentBenchmarkDecisionRunner()
    : aiAssisted
    ? createAiAssistedBenchmarkDecisionRunner()
    : offline
      ? createOfflineBenchmarkDecisionRunner()
      : createOpenAiBenchmarkDecisionRunner();
  const report = await runMultiRegimeBenchmark(
    fixture,
    decisionRunner,
    {
      fixturePath,
      liveModel: liveAssessment || (!offline && !aiAssisted),
      model: aiAssisted ? "ai-assisted-ensemble-offline" : liveAssessment ? `openai-candidate-assessment:${modelName(true)}` : undefined,
    },
  );
  await writeMultiRegimeBenchmark(report, outputPath);
  console.log(JSON.stringify(summaryOnly ? { ...report.aggregate, model: report.model, fixture: report.fixture } : report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as Error;
    console.error(`[multi-regime-eval] failed: ${e.message}`);
    process.exitCode = 1;
  });
}
