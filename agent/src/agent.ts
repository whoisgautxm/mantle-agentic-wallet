import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { parseEther } from "viem";
import {
  readVaultState,
  submitExecute,
  isTargetAllowed,
  readPrice,
  getGasPriceWei,
  getHeadBlock,
  ExecuteRevertedError,
} from "./chain.js";
import {
  candidateAmountWei,
  candidateMaterialChangeReason,
  driftBps,
} from "./candidateRevalidation.js";
import { evaluateCostGate } from "./risk/costGate.js";
import { checkSnapshotFreshness } from "./risk/freshness.js";
import {
  buildCandidateFromStrategy,
  buildDecisionFromApprovedCandidate,
  decide,
  type DecisionOptions,
  type ReasoningClient,
  type ReasoningProvider,
  type TradeCandidate,
} from "./brain.js";
import { chain, aiVaultAddress, dexAddress, agentAccount, mockTokenAddress } from "./config.js";
import { computeMarketFeatures } from "./marketFeatures.js";
import { createOracleRouterFromEnv } from "./oracles/router.js";
import { gasAdjustedRoiBps, portfolioSnapshot, portfolioValueWei, roiBps } from "./pnl.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import type { ProtocolAdapter } from "./protocols/types.js";
import { createProtocolRegistry } from "./protocols/registry.js";
import { evaluateRisk } from "./risk/engine.js";
import { loadRiskLimitsFromEnv } from "./risk/limits.js";
import { simulateExecute } from "./simulation/simulator.js";
import { regimeRoutedEnsemble } from "./strategies/ensemble.js";
import { sendAlert } from "./telegram.js";
import { createJsonlTraceWriter } from "./tracing.js";
import type { Decision, VaultState } from "./types.js";

function createReasoningClient(): ReasoningClient {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase() as ReasoningProvider;
  if (provider === "anthropic") {
    return { provider, anthropic: new Anthropic() };
  }
  if (provider === "openai") {
    return { provider, openai: new OpenAI() };
  }
  throw new Error(`unsupported AI_PROVIDER: ${provider}`);
}

const client = createReasoningClient();
const protocolRegistry = createProtocolRegistry([createMockDexAdapter(dexAddress, mockTokenAddress, readPrice)]);
const protocol = protocolRegistry.requireExecutable("mockdex");
const oracleRouter = createOracleRouterFromEnv(readPrice);
const riskLimits = loadRiskLimitsFromEnv();
const PRICE_HISTORY_MAX = 12;
const MAX_DRAWDOWN_BPS = -1500n;
const ESTIMATED_EXECUTION_COST_BPS = Number(process.env.AGENT_ESTIMATED_EXECUTION_COST_BPS ?? "60");
const PRE_MODEL_COST_GATE = (process.env.AGENT_PRE_MODEL_COST_GATE ?? "1") === "1";
const PRE_MODEL_GAS_ESTIMATE_UNITS = BigInt(process.env.AGENT_PRE_MODEL_GAS_ESTIMATE_UNITS ?? "170000");
const POST_MODEL_REVALIDATION = (process.env.AGENT_POST_MODEL_REVALIDATION ?? "1") === "1";
const REVALIDATION_MAX_PRICE_DRIFT_BPS = BigInt(process.env.AGENT_REVALIDATION_MAX_PRICE_DRIFT_BPS ?? "150");
const REVALIDATION_MAX_AMOUNT_DRIFT_BPS = BigInt(process.env.AGENT_REVALIDATION_MAX_AMOUNT_DRIFT_BPS ?? "250");
const PRICE_FRESHNESS_BPS = BigInt(process.env.AGENT_PRICE_FRESHNESS_BPS ?? process.env.EXECUTION_SLIPPAGE_BPS ?? "100");
// P1 gates (default off — enable deliberately for a controlled run; see live-run report sections 6, 10).
const DYNAMIC_COST_GATE = (process.env.AGENT_DYNAMIC_COST_GATE ?? "0") === "1";
const MAX_BLOCK_DRIFT = BigInt(process.env.AGENT_MAX_BLOCK_DRIFT ?? "0"); // 0 disables the freshness guard
const FEE_BPS = Number(process.env.AGENT_FEE_BPS ?? "0");
const SLIPPAGE_BPS = Number(process.env.EXECUTION_SLIPPAGE_BPS ?? "100");
const COST_BUFFER_BPS = Number(process.env.AGENT_COST_BUFFER_BPS ?? "10");
const AGENT_STRATEGY = (process.env.AGENT_STRATEGY ?? "ensemble").toLowerCase();
if (AGENT_STRATEGY !== "model" && AGENT_STRATEGY !== "ensemble") {
  throw new Error("AGENT_STRATEGY must be model or ensemble");
}
const strategyPrior = AGENT_STRATEGY === "ensemble" ? regimeRoutedEnsemble : undefined;
const strategyBaselineBuyWei = parseEther(process.env.AGENT_STRATEGY_BASELINE_MNT ?? "0.005");
const priceHistory: bigint[] = [];
const trace = createJsonlTraceWriter();
let peakValueWei = 0n;
let benchmarkStartValueWei = 0n;
let cumulativeGasWei = 0n;
let breakerTripped = false;

type ExecuteDecision = Extract<Decision, { kind: "execute" }>;

async function recordTrace(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await trace.append(type, payload);
  } catch (error) {
    const e = error as any;
    console.warn("[trace] write failed:", e?.message ?? "unknown error");
  }
}

async function recordTerminalError(runner: string, tickId: string, error: unknown): Promise<void> {
  const reverted = error instanceof ExecuteRevertedError;
  await recordTrace("agent.final_action", {
    tickId,
    runner,
    outcome: reverted ? "reverted" : "error",
    reason: (error as any)?.message ?? "unknown error",
    ...(reverted
      ? {
          txHash: (error as ExecuteRevertedError).hash,
          gas: {
            gasUsedWei: (error as ExecuteRevertedError).gasUsedWei.toString(),
            gasCostWei: (error as ExecuteRevertedError).gasCostWei.toString(),
          },
        }
      : {}),
  });
}

async function recordDecisionMetadata(tickId: string, decision: { agentTrace?: Record<string, unknown> }): Promise<void> {
  const agentTrace = decision.agentTrace as any;
  if (!agentTrace) return;
  if (agentTrace.candidate || agentTrace.strategyIntent || agentTrace.candidateGate) {
    await recordTrace("agent.candidate", {
      tickId,
      runner: "ai",
      decisionMode: agentTrace.decisionMode,
      strategyIntent: agentTrace.strategyIntent,
      candidate: agentTrace.candidate,
      candidateGate: agentTrace.candidateGate,
    });
  }
  if (agentTrace.modelAssessment || agentTrace.modelAssessmentError) {
    await recordTrace("agent.model_assessment", {
      tickId,
      runner: "ai",
      decisionMode: agentTrace.decisionMode,
      candidateId: agentTrace.candidate?.id,
      assessment: agentTrace.modelAssessment,
      error: agentTrace.modelAssessmentError,
    });
  }
  if (agentTrace.assessmentValidation) {
    await recordTrace("agent.candidate_merge", {
      tickId,
      runner: "ai",
      decisionMode: agentTrace.decisionMode,
      candidateId: agentTrace.candidate?.id,
      validation: agentTrace.assessmentValidation,
    });
  }
}

function currentDecisionOptions(preModelGasPriceWei?: bigint): DecisionOptions {
  return {
    estimatedExecutionCostBps: Number.isFinite(ESTIMATED_EXECUTION_COST_BPS)
      ? ESTIMATED_EXECUTION_COST_BPS
      : 60,
    preModelGasEstimateUnits: PRE_MODEL_COST_GATE ? PRE_MODEL_GAS_ESTIMATE_UNITS : undefined,
    preModelGasPriceWei,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    costBufferBps: COST_BUFFER_BPS,
    strategyPrior,
    strategyBaselineBuyWei,
  };
}

function quotePriceWeiFromDecision(decision: ExecuteDecision, fallback: bigint): bigint {
  const quote = decision.agentTrace?.quote as { priceWei?: bigint } | undefined;
  return typeof quote?.priceWei === "bigint" ? quote.priceWei : fallback;
}

async function revalidatedPriceFreshness(
  decision: ExecuteDecision,
  quotePriceWei: bigint,
): Promise<Record<string, unknown> | undefined> {
  if (decision.agentTrace?.decisionMode !== "candidate_revalidated") return undefined;
  const currentDexPriceWei = await readPrice();
  const currentOracle = await oracleRouter.getPrice("MNT/MOCK");
  const quoteDriftBps = driftBps(currentDexPriceWei, quotePriceWei);
  const oracleDriftBps = driftBps(currentOracle.priceWei, quotePriceWei);
  const dexOracleDriftBps = driftBps(currentDexPriceWei, currentOracle.priceWei);
  const ok =
    !currentOracle.stale &&
    quoteDriftBps <= PRICE_FRESHNESS_BPS &&
    oracleDriftBps <= PRICE_FRESHNESS_BPS &&
    dexOracleDriftBps <= BigInt(riskLimits.maxDexOracleDeviationBps);
  return {
    ok,
    mode: "price_freshness_after_revalidation",
    quotePriceWei,
    currentDexPriceWei,
    currentOracle,
    quoteDriftBps,
    oracleDriftBps,
    dexOracleDriftBps,
    maxPriceFreshnessBps: PRICE_FRESHNESS_BPS,
  };
}

type RevalidationResult =
  | {
      ok: true;
      decision: ExecuteDecision;
      state: VaultState;
      oracle: Awaited<ReturnType<typeof oracleRouter.getPrice>>;
      portfolio: ReturnType<typeof portfolioSnapshot>;
      quotePriceWei: bigint;
      revalidation: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: string;
      ruleId: string;
      state?: VaultState;
      oracle?: Awaited<ReturnType<typeof oracleRouter.getPrice>>;
      portfolio?: ReturnType<typeof portfolioSnapshot>;
      revalidation: Record<string, unknown>;
    };

async function revalidateCandidateDecision(
  originalDecision: ExecuteDecision,
  originalState: VaultState,
  originalOracle: Awaited<ReturnType<typeof oracleRouter.getPrice>>,
  originalPortfolio: ReturnType<typeof portfolioSnapshot>,
  adapter: ProtocolAdapter,
): Promise<RevalidationResult> {
  const originalCandidate = originalDecision.agentTrace?.candidate as TradeCandidate | undefined;
  const modelAssessment = originalDecision.agentTrace?.modelAssessment;
  if (!POST_MODEL_REVALIDATION || !originalCandidate || !strategyPrior) {
    return {
      ok: true,
      decision: originalDecision,
      state: originalState,
      oracle: originalOracle,
      portfolio: originalPortfolio,
      quotePriceWei: quotePriceWeiFromDecision(originalDecision, originalState.priceWei),
      revalidation: { skipped: true, reason: !POST_MODEL_REVALIDATION ? "disabled" : "not_candidate_assessment" },
    };
  }

  const refreshedState = await readVaultState(aiVaultAddress);
  const refreshedOracle = await oracleRouter.getPrice("MNT/MOCK");
  const refreshedPortfolio = portfolioSnapshot(refreshedState, benchmarkStartValueWei);
  const refreshedHistory = [...priceHistory.slice(1), refreshedState.priceWei].slice(-PRICE_HISTORY_MAX);
  const refreshedFeatures = computeMarketFeatures(refreshedHistory);
  let refreshedGasPriceWei: bigint | undefined;
  if (PRE_MODEL_COST_GATE) {
    try {
      refreshedGasPriceWei = await getGasPriceWei();
    } catch (error) {
      console.warn("[cost gate] revalidation gas price unavailable; falling back to fixed bps gate", error);
    }
  }
  const refreshedCandidateResult = buildCandidateFromStrategy(
    refreshedState,
    refreshedHistory,
    refreshedFeatures,
    currentDecisionOptions(refreshedGasPriceWei),
  );
  const baseRevalidation = {
    originalCandidate,
    modelAssessment,
    refreshedBlockNumber: refreshedState.blockNumber?.toString(),
    refreshedPriceWei: refreshedState.priceWei,
    refreshedHistory,
    refreshedCandidate: refreshedCandidateResult.candidate,
    refreshedCandidateGate: {
      reason: refreshedCandidateResult.reason,
      strategyIntent: refreshedCandidateResult.strategyIntent,
      economicGate: refreshedCandidateResult.economicGate,
    },
  };

  if (!refreshedCandidateResult.candidate) {
    return {
      ok: false,
      reason: `post-model revalidation blocked: ${refreshedCandidateResult.reason}`,
      ruleId: "POST_MODEL_REVALIDATION_NO_CANDIDATE",
      state: refreshedState,
      oracle: refreshedOracle,
      portfolio: refreshedPortfolio,
      revalidation: baseRevalidation,
    };
  }

  const materialChange = candidateMaterialChangeReason(
    originalCandidate,
    refreshedCandidateResult.candidate,
    originalState,
    refreshedState,
    {
      maxPriceDriftBps: REVALIDATION_MAX_PRICE_DRIFT_BPS,
      maxAmountDriftBps: REVALIDATION_MAX_AMOUNT_DRIFT_BPS,
    },
  );
  if (materialChange) {
    return {
      ok: false,
      reason: `post-model revalidation blocked: ${materialChange}`,
      ruleId: "POST_MODEL_REVALIDATION_MATERIAL_CHANGE",
      state: refreshedState,
      oracle: refreshedOracle,
      portfolio: refreshedPortfolio,
      revalidation: { ...baseRevalidation, materialChange },
    };
  }

  const rationale =
    `${refreshedCandidateResult.candidate.rationale} ` +
    `Safety sizing: reused prior OpenAI approval after fresh deterministic revalidation.`;
  const refreshedDecision = await buildDecisionFromApprovedCandidate(
    refreshedCandidateResult.candidate,
    adapter,
    refreshedCandidateResult.analysis,
    rationale,
    {
      ...(originalDecision.agentTrace ?? {}),
      decisionMode: "candidate_revalidated",
      originalCandidate,
      modelAssessment,
      candidateGate: baseRevalidation.refreshedCandidateGate,
      revalidation: baseRevalidation,
    },
  );
  if (refreshedDecision.kind !== "execute") {
    return {
      ok: false,
      reason: "post-model revalidation produced a non-executable decision",
      ruleId: "POST_MODEL_REVALIDATION_NON_EXECUTE",
      state: refreshedState,
      oracle: refreshedOracle,
      portfolio: refreshedPortfolio,
      revalidation: baseRevalidation,
    };
  }

  return {
    ok: true,
    decision: refreshedDecision,
    state: refreshedState,
    oracle: refreshedOracle,
    portfolio: refreshedPortfolio,
    quotePriceWei: quotePriceWeiFromDecision(refreshedDecision, refreshedState.priceWei),
    revalidation: {
      ...baseRevalidation,
      refreshedDecision,
      priceDriftBps: driftBps(refreshedState.priceWei, originalState.priceWei),
      amountDriftBps: driftBps(
        candidateAmountWei(refreshedCandidateResult.candidate),
        candidateAmountWei(originalCandidate),
      ),
    },
  };
}

async function tick(tickId: string, context: string): Promise<void> {
  await recordTrace("agent.tick.started", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    provider: client.provider,
    protocolId: protocol.id,
  });

  // Atomic, block-pinned snapshot first. Push its canonical same-block price to history so the
  // features (computed from history) and the prompt (state.priceWei) can never disagree — this is
  // the fix for the 369 bps split-snapshot bug in the live-run report (section 9).
  const state = await readVaultState(aiVaultAddress);
  priceHistory.push(state.priceWei);
  if (priceHistory.length > PRICE_HISTORY_MAX) priceHistory.shift();

  const oracle = await oracleRouter.getPrice("MNT/MOCK");
  if (oracle.warnings?.length) console.warn("[oracle]", oracle.warnings.join("; "));
  const portfolioValue = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, state.priceWei);
  if (benchmarkStartValueWei === 0n) benchmarkStartValueWei = portfolioValue;
  const portfolio = portfolioSnapshot(state, benchmarkStartValueWei);
  console.log("[state]", {
    mnt: state.balanceWei.toString(),
    token: state.tokenBalanceWei.toString(),
    price: state.priceWei.toString(),
    spentToday: state.spentToday.toString(),
    paused: state.paused,
  });
  await recordTrace("agent.observation", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    blockNumber: state.blockNumber?.toString(),
    oracle,
    state,
    portfolio,
    priceHistory,
  });

  if (state.paused) {
    console.log("[paused] skipping");
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      reason: "vault paused",
      portfolioAfter: portfolio,
    });
    return;
  }

  if (portfolioValue > peakValueWei) peakValueWei = portfolioValue;
  const drawdownBps = roiBps(portfolioValue, peakValueWei);
  if (drawdownBps <= MAX_DRAWDOWN_BPS) {
    if (!breakerTripped) {
      breakerTripped = true;
      console.warn("[breaker] drawdown limit hit; soft-pausing AI trading", {
        portfolioValue: portfolioValue.toString(),
        peakValue: peakValueWei.toString(),
        drawdownBps: drawdownBps.toString(),
      });
    }
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      reason: "drawdown breaker",
      portfolioValue,
      peakValueWei,
      drawdownBps,
      portfolioAfter: portfolio,
    });
    return;
  }

  const adapterTrace: Record<string, unknown> = {};
  const tracedProtocol = {
    ...protocol,
    async quote(intent: Parameters<typeof protocol.quote>[0]) {
      adapterTrace.intent = intent;
      const quote = await protocol.quote(intent);
      adapterTrace.quote = quote;
      await recordTrace("agent.quote", {
        tickId,
        runner: "ai",
        protocolId: protocol.id,
        intent,
        quote,
      });
      return quote;
    },
    buildPlan(intent: Parameters<typeof protocol.buildPlan>[0], quote: Parameters<typeof protocol.buildPlan>[1]) {
      const plan = protocol.buildPlan(intent, quote);
      adapterTrace.plan = plan;
      return plan;
    },
  };

  let preModelGasPriceWei: bigint | undefined;
  if (PRE_MODEL_COST_GATE) {
    try {
      preModelGasPriceWei = await getGasPriceWei();
    } catch (error) {
      console.warn("[cost gate] pre-model gas price unavailable; falling back to fixed bps gate", error);
    }
  }

  const decision = await decide(client, state, priceHistory, tracedProtocol, context, currentDecisionOptions(preModelGasPriceWei));
  console.log("[decision]", decision.kind, "-", decision.rationale);
  await recordDecisionMetadata(tickId, decision);
  await recordTrace("agent.decision", {
    tickId,
    runner: "ai",
    decision,
    ...adapterTrace,
  });
  if (decision.kind === "hold") {
    await sendAlert(decision);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      decision,
      portfolioAfter: portfolio,
    });
    return;
  }

  const revalidation = await revalidateCandidateDecision(decision, state, oracle, portfolio, tracedProtocol);
  await recordTrace("agent.candidate_revalidation", {
    tickId,
    runner: "ai",
    ok: revalidation.ok,
    reason: revalidation.ok ? undefined : revalidation.reason,
    ruleId: revalidation.ok ? undefined : revalidation.ruleId,
    revalidation: revalidation.revalidation,
  });
  if (!revalidation.ok) {
    console.log("[guard] blocked:", revalidation.reason);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "blocked",
      reason: revalidation.reason,
      ruleId: revalidation.ruleId,
      decision,
      revalidation: revalidation.revalidation,
      portfolioAfter: revalidation.portfolio ?? portfolio,
    });
    return;
  }

  const executionDecision = revalidation.decision;
  const executionState = revalidation.state;
  const executionOracle = revalidation.oracle;
  const executionPortfolio = revalidation.portfolio;
  const executionQuotePriceWei = revalidation.quotePriceWei;

  const simulation = await simulateExecute(aiVaultAddress, executionDecision, agentAccount.address);
  await recordTrace("agent.simulation", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    simulation,
  });
  const risk = evaluateRisk({
    decision: executionDecision,
    state: executionState,
    allowedTargets: protocolRegistry.allowedTargets(),
    allowedSelectors: protocolRegistry.allowedSelectors(),
    oracle: executionOracle,
    quotePriceWei: executionQuotePriceWei,
    simulation,
    limits: riskLimits,
  });
  const executionPolicy = {
    localTargetAllowed: protocolRegistry.allowedTargets().includes(executionDecision.target),
    localSelectorAllowed: protocolRegistry.allowedSelectors().includes(
      executionDecision.calldata.slice(0, 10) as `0x${string}`,
    ),
  };
  await recordTrace("agent.risk", {
    tickId,
    runner: "ai",
    risk,
    limits: riskLimits,
    executionPolicy,
  });
  if (!risk.ok) {
    console.log("[guard] blocked:", risk.reason);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "blocked",
      reason: risk.reason,
      ruleId: risk.ruleId,
      decision: executionDecision,
      executionPolicy,
      portfolioAfter: executionPortfolio,
    });
    return;
  }

  const onchainTargetAllowed = await isTargetAllowed(aiVaultAddress, executionDecision.target);
  if (!onchainTargetAllowed) {
    console.log("[guard] blocked: target not allowlisted on-chain:", executionDecision.target);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "blocked",
      reason: "target not allowlisted on-chain",
      decision: executionDecision,
      executionPolicy: { ...executionPolicy, onchainTargetAllowed },
      portfolioAfter: executionPortfolio,
    });
    return;
  }

  // P1 quote-to-submit freshness: re-check head drift before submitting against a possibly-moved oracle floor.
  if (MAX_BLOCK_DRIFT > 0n && executionState.blockNumber !== undefined) {
    const headBlock = await getHeadBlock();
    const fresh = checkSnapshotFreshness({
      snapshotBlock: executionState.blockNumber,
      headBlock,
      maxDriftBlocks: MAX_BLOCK_DRIFT,
    });
    if (!fresh.ok) {
      const priceFreshness = await revalidatedPriceFreshness(executionDecision, executionQuotePriceWei);
      if (priceFreshness?.ok) {
        await recordTrace("agent.freshness", {
          tickId,
          runner: "ai",
          ok: true,
          blockFreshness: {
            driftBlocks: fresh.driftBlocks.toString(),
            maxDriftBlocks: MAX_BLOCK_DRIFT.toString(),
            acceptedDespiteBlockDrift: true,
            reason: fresh.reason,
          },
          priceFreshness,
        });
      } else {
        console.log("[guard] blocked: stale snapshot —", fresh.reason);
        await recordTrace("agent.final_action", {
          tickId,
          runner: "ai",
          outcome: "blocked",
          reason: `stale snapshot: ${fresh.reason}`,
          decision: executionDecision,
          freshness: {
            driftBlocks: fresh.driftBlocks.toString(),
            maxDriftBlocks: MAX_BLOCK_DRIFT.toString(),
            priceFreshness,
          },
          portfolioAfter: executionPortfolio,
        });
        return;
      }
    }
  }

  // P1 dynamic execution-cost gate: block uneconomic trades using observed gas vs trade notional.
  if (DYNAMIC_COST_GATE) {
    const gasPriceWei = await getGasPriceWei();
    const tradeNotionalWei = executionDecision.valueWei > 0n ? executionDecision.valueWei : executionDecision.expectedOutWei ?? 0n;
    const gate = evaluateCostGate({
      expectedEdgeBps: executionDecision.analysis?.expectedEdgeBps ?? 0,
      feeBps: FEE_BPS,
      slippageBps: SLIPPAGE_BPS,
      bufferBps: COST_BUFFER_BPS,
      gasEstimateWei: simulation.gasEstimate ?? 0n,
      gasPriceWei,
      tradeNotionalWei,
    });
    if (!gate.ok) {
      console.log("[guard] blocked: cost gate —", gate.reason);
      await recordTrace("agent.final_action", {
        tickId,
        runner: "ai",
        outcome: "blocked",
        reason: `cost gate: ${gate.reason}`,
        decision: executionDecision,
        costGate: { gasBps: gate.gasBps, totalCostBps: gate.totalCostBps },
        portfolioAfter: executionPortfolio,
      });
      return;
    }
  }

  const { hash, gasUsedWei, gasCostWei } = await submitExecute(aiVaultAddress, executionDecision, undefined, { simulation });
  cumulativeGasWei += gasCostWei;
  const base = (chain.blockExplorers?.default.url ?? "").replace(/\/$/, "");
  console.log("[executed]", `${base}/tx/${hash}`, `gas=${gasCostWei.toString()}`);
  await sendAlert(decision, hash);
  const stateAfter = await readVaultState(aiVaultAddress);
  const portfolioAfter = portfolioSnapshot(stateAfter, benchmarkStartValueWei);
  await recordTrace("agent.final_action", {
    tickId,
    runner: "ai",
    outcome: "executed",
    txHash: hash,
    decision: executionDecision,
    executionPolicy: { ...executionPolicy, onchainTargetAllowed },
    portfolioBefore: executionPortfolio,
    portfolioAfter,
    gas: {
      gasUsedWei: gasUsedWei.toString(),
      gasCostWei: gasCostWei.toString(),
      cumulativeGasWei: cumulativeGasWei.toString(),
      gasAdjustedRoiBps: gasAdjustedRoiBps(
        portfolioAfter.portfolioValueWei,
        cumulativeGasWei,
        benchmarkStartValueWei,
      ).toString(),
    },
  });
}

async function main() {
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? "60000");
  const context =
    process.env.AGENT_CONTEXT ??
    "Trade conservatively. Prefer holding unless recent price action gives a clear low-risk edge.";

  console.log("[agent] AI trader starting on", chain.name, "using", client.provider);

  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      const tickId = randomUUID();
      try {
        await tick(tickId, context);
      } catch (e) {
        console.error("[tick error]", e);
        // Guarantee exactly one terminal event for this started tick (reverted or error).
        await recordTerminalError("ai", tickId, e);
      } finally {
        running = false;
      }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
