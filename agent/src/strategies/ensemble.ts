import type { MarketFeatures } from "../marketFeatures.js";
import type { VaultState } from "../types.js";

const BPS = 10_000n;

export const DEFAULT_MIN_CONFIDENCE = 55;
export const DEFAULT_EDGE_BUFFER_BPS = 10;

export interface StrategyInput {
  priceHistory: readonly bigint[];
  features: MarketFeatures;
  state: VaultState;
  baselineBuyWei: bigint;
  estimatedExecutionCostBps?: number;
}

export interface StrategyIntent {
  action: "buy" | "sell" | "hold";
  amountMntWei?: bigint;
  amountTokenWei?: bigint;
  sizePercent: number;
  expectedEdgeBps: number;
  rationale: string;
}

export type StrategyFunction = (input: StrategyInput) => StrategyIntent;

export interface EnsembleConfig {
  minimumConfidence: number;
  edgeBufferBps: number;
  trendBuyMinPercent: number;
  trendBuyMaxPercent: number;
  trendEntryMomentumBps: number;
  trendDownTrimPercent: number;
  rangeDeviationBps: number;
  rangeBuyPercent: number;
  rangeSellPercent: number;
  rangeBuyBaselineMultiplierBps: number;
  shockThresholdBps: number;
  shockRecoveryMinBps: number;
  shockRecoveryBuyPercent: number;
}

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  minimumConfidence: DEFAULT_MIN_CONFIDENCE,
  edgeBufferBps: DEFAULT_EDGE_BUFFER_BPS,
  trendBuyMinPercent: 50,
  trendBuyMaxPercent: 80,
  trendEntryMomentumBps: 200,
  trendDownTrimPercent: 25,
  rangeDeviationBps: 100,
  rangeBuyPercent: 30,
  rangeSellPercent: 35,
  rangeBuyBaselineMultiplierBps: 15_000,
  shockThresholdBps: 1_200,
  shockRecoveryMinBps: 100,
  shockRecoveryBuyPercent: 15,
};

function minBigint(...values: bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

function absolute(value: number): number {
  return value < 0 ? -value : value;
}

function average(values: readonly bigint[]): bigint {
  if (!values.length) return 0n;
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

function deviationBps(reference: bigint, value: bigint): number {
  if (reference <= 0n) return 0;
  return Number(((value - reference) * BPS) / reference);
}

function buyCapacity(state: VaultState): bigint {
  const dailyRemaining = state.spentToday >= state.dailyLimit ? 0n : state.dailyLimit - state.spentToday;
  return minBigint(state.balanceWei, state.spendLimitPerTx, dailyRemaining);
}

function percentage(value: bigint, percent: number): bigint {
  return (value * BigInt(percent)) / 100n;
}

function hold(expectedEdgeBps: number, rationale: string): StrategyIntent {
  return { action: "hold", sizePercent: 0, expectedEdgeBps, rationale };
}

function costGate(
  intent: StrategyIntent,
  input: StrategyInput,
  config: EnsembleConfig,
): StrategyIntent {
  if (intent.action === "hold") return intent;
  const requiredEdgeBps = (input.estimatedExecutionCostBps ?? 0) + config.edgeBufferBps;
  if (input.features.confidence < config.minimumConfidence) {
    return hold(
      intent.expectedEdgeBps,
      `Ensemble held because confidence ${input.features.confidence} is below ${config.minimumConfidence}.`,
    );
  }
  if (intent.expectedEdgeBps <= requiredEdgeBps) {
    return hold(
      intent.expectedEdgeBps,
      `Ensemble held because expected edge ${intent.expectedEdgeBps} bps does not exceed the ${requiredEdgeBps} bps cost threshold.`,
    );
  }
  return intent;
}

function trendBuyPercent(confidence: number, config: EnsembleConfig): number {
  const confidenceRange = Math.max(1, 100 - config.minimumConfidence);
  const confidenceAboveFloor = Math.max(0, confidence - config.minimumConfidence);
  const extra =
    ((config.trendBuyMaxPercent - config.trendBuyMinPercent) * confidenceAboveFloor) /
    confidenceRange;
  return Math.min(config.trendBuyMaxPercent, Math.round(config.trendBuyMinPercent + extra));
}

function hasRecentShock(priceHistory: readonly bigint[], thresholdBps: number): boolean {
  const recent = priceHistory.slice(-5);
  for (let index = 1; index < recent.length; index += 1) {
    if (deviationBps(recent[index - 1], recent[index]) <= -thresholdBps) return true;
  }
  return false;
}

export function regimeRoutedEnsemble(
  input: StrategyInput,
  config: EnsembleConfig = DEFAULT_ENSEMBLE_CONFIG,
): StrategyIntent {
  const { features, state, priceHistory } = input;
  const capacity = buyCapacity(state);

  if (features.regime === "trend_up") {
    const expectedEdgeBps = Math.max(
      0,
      features.shortSlopeBps,
      features.longSlopeBps,
      features.latestReturnBps,
    );
    if (
      features.latestReturnBps <= 0 ||
      features.consecutiveUp < 2 ||
      features.momentumBps < config.trendEntryMomentumBps ||
      capacity <= 0n
    ) {
      return hold(expectedEdgeBps, "Ensemble held because the uptrend continuation signal weakened.");
    }
    const sizePercent = trendBuyPercent(features.confidence, config);
    return costGate(
      {
        action: "buy",
        amountMntWei: percentage(capacity, sizePercent),
        sizePercent,
        expectedEdgeBps,
        rationale: "Ensemble followed a confirmed uptrend and added without selling the winning position.",
      },
      input,
      config,
    );
  }

  if (features.regime === "trend_down") {
    const expectedEdgeBps = Math.max(
      0,
      absolute(features.shortSlopeBps),
      absolute(features.longSlopeBps),
      absolute(features.latestReturnBps),
    );
    if (state.tokenBalanceWei <= 0n) {
      return hold(expectedEdgeBps, "Ensemble preserved cash and refused to buy a confirmed downtrend.");
    }
    return costGate(
      {
        action: "sell",
        amountTokenWei: percentage(state.tokenBalanceWei, config.trendDownTrimPercent),
        sizePercent: config.trendDownTrimPercent,
        expectedEdgeBps,
        rationale: "Ensemble reduced inventory during a confirmed downtrend and did not buy the dip.",
      },
      input,
      config,
    );
  }

  if (features.regime === "shock") {
    const expectedEdgeBps = Math.max(0, features.latestReturnBps);
    const recovering =
      features.latestReturnBps >= config.shockRecoveryMinBps &&
      features.drawdownFromPeakBps <= -config.rangeDeviationBps &&
      hasRecentShock(priceHistory, config.shockThresholdBps);
    if (!recovering || capacity <= 0n) {
      return hold(expectedEdgeBps, "Ensemble stayed risk-off until a post-shock recovery was observable.");
    }
    return costGate(
      {
        action: "buy",
        amountMntWei: minBigint(
          percentage(capacity, config.shockRecoveryBuyPercent),
          input.baselineBuyWei,
        ),
        sizePercent: config.shockRecoveryBuyPercent,
        expectedEdgeBps,
        rationale: "Ensemble made a small recovery entry only after a positive post-shock signal.",
      },
      input,
      config,
    );
  }

  if (features.regime === "range" && priceHistory.length >= 2) {
    const current = priceHistory[priceHistory.length - 1];
    const recentAverage = average(priceHistory.slice(0, -1));
    const distanceBps = deviationBps(recentAverage, current);
    const expectedEdgeBps = absolute(distanceBps);

    if (distanceBps <= -config.rangeDeviationBps && capacity > 0n) {
      const baselineScaled =
        (input.baselineBuyWei * BigInt(config.rangeBuyBaselineMultiplierBps)) / BPS;
      return costGate(
        {
          action: "buy",
          amountMntWei: minBigint(percentage(capacity, config.rangeBuyPercent), baselineScaled),
          sizePercent: config.rangeBuyPercent,
          expectedEdgeBps,
          rationale: "Ensemble bought a cost-worthy discount below the observed range mean.",
        },
        input,
        config,
      );
    }
    if (
      distanceBps >= config.rangeDeviationBps &&
      state.tokenBalanceWei > 0n
    ) {
      return costGate(
        {
          action: "sell",
          amountTokenWei: percentage(state.tokenBalanceWei, config.rangeSellPercent),
          sizePercent: config.rangeSellPercent,
          expectedEdgeBps,
          rationale: "Ensemble realized part of the range premium above the observed mean.",
        },
        input,
        config,
      );
    }
    return hold(expectedEdgeBps, "Ensemble found no cost-worthy deviation from the observed range mean.");
  }

  return hold(0, "Ensemble held because the observed regime was uncertain.");
}
