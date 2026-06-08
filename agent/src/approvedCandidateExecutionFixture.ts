import { computeMarketFeatures } from "./marketFeatures.js";
import type { PriceSnapshot } from "./oracles/types.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { checkSnapshotFreshness, type FreshnessResult } from "./risk/freshness.js";
import { evaluateRisk } from "./risk/engine.js";
import type { RiskResult } from "./risk/types.js";
import { DEFAULT_RISK_LIMITS, type RiskLimits } from "./risk/limits.js";
import { evaluateCostGate, type CostGateResult } from "./risk/costGate.js";
import { type SimulationResult } from "./simulation/types.js";
import { regimeRoutedEnsemble, type StrategyFunction } from "./strategies/ensemble.js";
import { jsonSafe } from "./tracing.js";
import type { Decision, VaultState } from "./types.js";
import {
  buildCandidateFromStrategy,
  buildDecisionFromApprovedCandidate,
  buildDecisionFromCandidateAssessment,
  parseCandidateAssessment,
  type CandidateAssessment,
  type CandidateBuildResult,
  type DecisionOptions,
  type TradeCandidate,
} from "./brain.js";
import { candidateAmountWei, candidateMaterialChangeReason, driftBps } from "./candidateRevalidation.js";

const ONE = 10n ** 18n;
const DEX = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;

export interface PriceFreshnessResult {
  ok: boolean;
  quoteDriftBps: bigint;
  oracleDriftBps: bigint;
  dexOracleDriftBps: bigint;
  maxPriceFreshnessBps: bigint;
  quotePriceWei: bigint;
  currentDexPriceWei: bigint;
  currentOracle: PriceSnapshot;
}

export interface ApprovedCandidateExecutionFixtureConfig {
  initialState?: VaultState;
  refreshedState?: VaultState;
  currentDexPriceWei?: bigint;
  currentOracle?: PriceSnapshot;
  priceHistory?: readonly bigint[];
  refreshedPriceHistory?: readonly bigint[];
  headBlock?: bigint;
  maxBlockDriftBlocks?: bigint;
  maxPriceDriftBps?: bigint;
  maxAmountDriftBps?: bigint;
  maxPriceFreshnessBps?: bigint;
  gasEstimateWei?: bigint;
  gasPriceWei?: bigint;
  feeBps?: number;
  slippageBps?: number;
  costBufferBps?: number;
  riskLimits?: RiskLimits;
  strategyPrior?: StrategyFunction;
  assessment?: CandidateAssessment;
}

export interface ApprovedCandidateExecutionFixtureReport {
  ok: boolean;
  finalOutcome: "ready_to_submit" | "blocked";
  blockedAt?: string;
  reason?: string;
  initialCandidate?: TradeCandidate;
  modelAssessment?: CandidateAssessment;
  initialDecision?: Decision;
  refreshedCandidate?: TradeCandidate;
  refreshedDecision?: Decision;
  revalidation?: {
    ok: boolean;
    reason?: string;
    priceDriftBps?: bigint;
    amountDriftBps?: bigint;
    refreshedCandidateGate?: CandidateBuildResult["reason"];
  };
  simulation?: SimulationResult;
  risk?: RiskResult;
  blockFreshness?: FreshnessResult;
  priceFreshness?: PriceFreshnessResult;
  costGate?: CostGateResult;
}

function state(overrides: Partial<VaultState> = {}): VaultState {
  return {
    balanceWei: 10n * ONE,
    spendLimitPerTx: 3n * ONE,
    dailyLimit: 10n * ONE,
    spentToday: 0n,
    windowStart: 1_000n,
    paused: false,
    tokenBalanceWei: 0n,
    priceWei: 2n * ONE,
    blockNumber: 100n,
    ...overrides,
  };
}

function defaultPriceHistory(): bigint[] {
  return [
    2_000_000_000_000_000_000n,
    2_030_000_000_000_000_000n,
    2_060_000_000_000_000_000n,
    2_090_000_000_000_000_000n,
  ];
}

function quotePriceWei(decision: ExecuteDecision, fallback: bigint): bigint {
  const quote = decision.agentTrace?.quote as { priceWei?: bigint } | undefined;
  return typeof quote?.priceWei === "bigint" ? quote.priceWei : fallback;
}

function defaultStrategyPrior(amountMntWei = 2n * ONE, expectedEdgeBps = 600): StrategyFunction {
  return (input) => {
    const routed = regimeRoutedEnsemble(input);
    if (routed.action !== "buy") return routed;
    return {
      action: "buy",
      amountMntWei,
      sizePercent: 20,
      expectedEdgeBps,
      rationale: "Fixture strategy approved a cost-worthy uptrend buy candidate.",
    };
  };
}

function approval(candidate: TradeCandidate): CandidateAssessment {
  return parseCandidateAssessment({
    candidateId: candidate.id,
    verdict: "approve",
    vetoCode: "none",
    confidence: 95,
    evidence: [
      "Candidate is state-consistent.",
      "The deterministic candidate is a buy in a confirmed uptrend.",
      "The expected edge is intentionally above the fixture cost model.",
    ],
    rationale: "Approve the deterministic fixture candidate.",
  });
}

function priceFreshness(input: {
  quotePriceWei: bigint;
  currentDexPriceWei: bigint;
  currentOracle: PriceSnapshot;
  maxPriceFreshnessBps: bigint;
  maxDexOracleDeviationBps: bigint;
}): PriceFreshnessResult {
  const quoteDriftBps = driftBps(input.currentDexPriceWei, input.quotePriceWei);
  const oracleDriftBps = driftBps(input.currentOracle.priceWei, input.quotePriceWei);
  const dexOracleDriftBps = driftBps(input.currentDexPriceWei, input.currentOracle.priceWei);
  return {
    ok:
      !input.currentOracle.stale &&
      quoteDriftBps <= input.maxPriceFreshnessBps &&
      oracleDriftBps <= input.maxPriceFreshnessBps &&
      dexOracleDriftBps <= input.maxDexOracleDeviationBps,
    quoteDriftBps,
    oracleDriftBps,
    dexOracleDriftBps,
    maxPriceFreshnessBps: input.maxPriceFreshnessBps,
    quotePriceWei: input.quotePriceWei,
    currentDexPriceWei: input.currentDexPriceWei,
    currentOracle: input.currentOracle,
  };
}

function block(report: Partial<ApprovedCandidateExecutionFixtureReport>, blockedAt: string, reason: string) {
  return {
    ...report,
    ok: false,
    finalOutcome: "blocked" as const,
    blockedAt,
    reason,
  };
}

export async function runApprovedCandidateExecutionFixture(
  config: ApprovedCandidateExecutionFixtureConfig = {},
): Promise<ApprovedCandidateExecutionFixtureReport> {
  const riskLimits = config.riskLimits ?? DEFAULT_RISK_LIMITS;
  const initialState = config.initialState ?? state({ blockNumber: 100n, priceWei: 2_090_000_000_000_000_000n });
  const refreshedState = config.refreshedState ?? state({ blockNumber: 104n, priceWei: 2_100_000_000_000_000_000n });
  const currentDexPriceWei = config.currentDexPriceWei ?? 2_102_000_000_000_000_000n;
  const currentOracle =
    config.currentOracle ??
    ({
      pair: "MNT/MOCK",
      priceWei: currentDexPriceWei,
      source: "mockdex",
      updatedAt: 1_000n,
      stale: false,
      maxAgeSeconds: 300n,
    } satisfies PriceSnapshot);
  const priceHistory = [...(config.priceHistory ?? defaultPriceHistory())];
  const refreshedPriceHistory = [...(config.refreshedPriceHistory ?? [...priceHistory.slice(1), refreshedState.priceWei])];
  const gasEstimateWei = config.gasEstimateWei ?? 170_000n;
  const gasPriceWei = config.gasPriceWei ?? 50_000_000_000n;
  const maxPriceFreshnessBps = config.maxPriceFreshnessBps ?? 150n;
  const strategyPrior = config.strategyPrior ?? defaultStrategyPrior();
  let quotePrice = initialState.priceWei;
  const adapter = createMockDexAdapter(DEX, TOKEN, async () => quotePrice, { slippageBps: BigInt(config.slippageBps ?? 100) });
  const decisionOptions: DecisionOptions = {
    estimatedExecutionCostBps: 60,
    feeBps: config.feeBps ?? 0,
    slippageBps: config.slippageBps ?? 100,
    costBufferBps: config.costBufferBps ?? 10,
    strategyPrior,
    strategyBaselineBuyWei: 5n * 10n ** 15n,
  };

  const initialFeatures = computeMarketFeatures(priceHistory);
  const initialCandidateResult = buildCandidateFromStrategy(initialState, priceHistory, initialFeatures, decisionOptions, 1_000n);
  if (!initialCandidateResult.candidate) {
    return block(
      {
        revalidation: {
          ok: false,
          reason: initialCandidateResult.reason,
          refreshedCandidateGate: initialCandidateResult.reason,
        },
      },
      "initial_candidate",
      initialCandidateResult.reason,
    );
  }

  const modelAssessment = config.assessment ?? approval(initialCandidateResult.candidate);
  const initialDecision = await buildDecisionFromCandidateAssessment(
    initialCandidateResult.candidate,
    modelAssessment,
    adapter,
    initialState,
    initialCandidateResult.analysis,
  );
  if (initialDecision.kind !== "execute") {
    return block(
      { initialCandidate: initialCandidateResult.candidate, modelAssessment, initialDecision },
      "model_assessment",
      initialDecision.rationale,
    );
  }

  quotePrice = refreshedState.priceWei;
  const refreshedFeatures = computeMarketFeatures(refreshedPriceHistory);
  const refreshedCandidateResult = buildCandidateFromStrategy(
    refreshedState,
    refreshedPriceHistory,
    refreshedFeatures,
    decisionOptions,
    1_001n,
  );
  if (!refreshedCandidateResult.candidate) {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        revalidation: {
          ok: false,
          reason: refreshedCandidateResult.reason,
          refreshedCandidateGate: refreshedCandidateResult.reason,
        },
      },
      "revalidation",
      refreshedCandidateResult.reason,
    );
  }

  const materialChange = candidateMaterialChangeReason(
    initialCandidateResult.candidate,
    refreshedCandidateResult.candidate,
    initialState,
    refreshedState,
    {
      maxPriceDriftBps: config.maxPriceDriftBps ?? 150n,
      maxAmountDriftBps: config.maxAmountDriftBps ?? 400n,
    },
  );
  const amountDriftBps = driftBps(
    candidateAmountWei(refreshedCandidateResult.candidate),
    candidateAmountWei(initialCandidateResult.candidate),
  );
  const priceDriftBps = driftBps(refreshedState.priceWei, initialState.priceWei);
  if (materialChange) {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        refreshedCandidate: refreshedCandidateResult.candidate,
        revalidation: {
          ok: false,
          reason: materialChange,
          priceDriftBps,
          amountDriftBps,
          refreshedCandidateGate: refreshedCandidateResult.reason,
        },
      },
      "revalidation",
      materialChange,
    );
  }

  const refreshedDecision = await buildDecisionFromApprovedCandidate(
    refreshedCandidateResult.candidate,
    adapter,
    refreshedCandidateResult.analysis,
    `${refreshedCandidateResult.candidate.rationale} Safety sizing: reused prior fixture approval after deterministic revalidation.`,
    {
      decisionMode: "candidate_revalidated",
      originalCandidate: initialCandidateResult.candidate,
      modelAssessment,
    },
  );
  if (refreshedDecision.kind !== "execute") {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        refreshedCandidate: refreshedCandidateResult.candidate,
        refreshedDecision,
      },
      "revalidated_decision",
      refreshedDecision.rationale,
    );
  }

  const simulation: SimulationResult = { ok: true, gasEstimate: gasEstimateWei, warnings: [] };
  const quotePriceAfterRefresh = quotePriceWei(refreshedDecision, refreshedState.priceWei);
  const risk = evaluateRisk({
    decision: refreshedDecision,
    state: refreshedState,
    allowedTargets: [adapter.target],
    allowedSelectors: adapter.allowedSelectors,
    oracle: currentOracle,
    quotePriceWei: quotePriceAfterRefresh,
    simulation,
    limits: riskLimits,
  });
  if (!risk.ok) {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        refreshedCandidate: refreshedCandidateResult.candidate,
        refreshedDecision,
        revalidation: {
          ok: true,
          priceDriftBps,
          amountDriftBps,
          refreshedCandidateGate: refreshedCandidateResult.reason,
        },
        simulation,
        risk,
      },
      "risk",
      risk.reason,
    );
  }

  const blockFreshness = checkSnapshotFreshness({
    snapshotBlock: refreshedState.blockNumber ?? 0n,
    headBlock: config.headBlock ?? 112n,
    maxDriftBlocks: config.maxBlockDriftBlocks ?? 3n,
  });
  const quoteFreshness = priceFreshness({
    quotePriceWei: quotePriceAfterRefresh,
    currentDexPriceWei,
    currentOracle,
    maxPriceFreshnessBps,
    maxDexOracleDeviationBps: riskLimits.maxDexOracleDeviationBps,
  });
  if (!blockFreshness.ok && !quoteFreshness.ok) {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        refreshedCandidate: refreshedCandidateResult.candidate,
        refreshedDecision,
        revalidation: {
          ok: true,
          priceDriftBps,
          amountDriftBps,
          refreshedCandidateGate: refreshedCandidateResult.reason,
        },
        simulation,
        risk,
        blockFreshness,
        priceFreshness: quoteFreshness,
      },
      "freshness",
      blockFreshness.reason ?? "stale snapshot and quote freshness failed",
    );
  }

  const tradeNotionalWei = refreshedDecision.valueWei > 0n ? refreshedDecision.valueWei : refreshedDecision.expectedOutWei ?? 0n;
  const costGate = evaluateCostGate({
    expectedEdgeBps: refreshedDecision.analysis?.expectedEdgeBps ?? 0,
    feeBps: config.feeBps ?? 0,
    slippageBps: config.slippageBps ?? 100,
    bufferBps: config.costBufferBps ?? 10,
    gasEstimateWei,
    gasPriceWei,
    tradeNotionalWei,
  });
  if (!costGate.ok) {
    return block(
      {
        initialCandidate: initialCandidateResult.candidate,
        modelAssessment,
        initialDecision,
        refreshedCandidate: refreshedCandidateResult.candidate,
        refreshedDecision,
        revalidation: {
          ok: true,
          priceDriftBps,
          amountDriftBps,
          refreshedCandidateGate: refreshedCandidateResult.reason,
        },
        simulation,
        risk,
        blockFreshness,
        priceFreshness: quoteFreshness,
        costGate,
      },
      "cost_gate",
      costGate.reason ?? "cost gate failed",
    );
  }

  return {
    ok: true,
    finalOutcome: "ready_to_submit",
    initialCandidate: initialCandidateResult.candidate,
    modelAssessment,
    initialDecision,
    refreshedCandidate: refreshedCandidateResult.candidate,
    refreshedDecision,
    revalidation: {
      ok: true,
      priceDriftBps,
      amountDriftBps,
      refreshedCandidateGate: refreshedCandidateResult.reason,
    },
    simulation,
    risk,
    blockFreshness,
    priceFreshness: quoteFreshness,
    costGate,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runApprovedCandidateExecutionFixture()
    .then((report) => {
      console.log(JSON.stringify(jsonSafe(report), null, 2));
      if (!report.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`[approved-candidate-fixture] ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
