const BPS = 10_000n;

export type MarketRegime = "trend_up" | "trend_down" | "range" | "shock" | "uncertain";

export interface MarketFeatures {
  observations: number;
  regime: MarketRegime;
  confidence: number;
  momentumBps: number;
  shortSlopeBps: number;
  longSlopeBps: number;
  volatilityBps: number;
  drawdownFromPeakBps: number;
  latestReturnBps: number;
  consecutiveUp: number;
  consecutiveDown: number;
}

function boundedNumber(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max) return Number.MAX_SAFE_INTEGER;
  if (value < -max) return -Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function returnBps(start: bigint, end: bigint): bigint {
  if (start <= 0n) return 0n;
  return ((end - start) * BPS) / start;
}

function averageAbsoluteReturns(prices: readonly bigint[]): bigint {
  if (prices.length < 2) return 0n;
  let total = 0n;
  for (let index = 1; index < prices.length; index += 1) {
    const value = returnBps(prices[index - 1], prices[index]);
    total += value < 0n ? -value : value;
  }
  return total / BigInt(prices.length - 1);
}

function directionalStreaks(prices: readonly bigint[]): { consecutiveUp: number; consecutiveDown: number } {
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let index = prices.length - 1; index > 0; index -= 1) {
    if (prices[index] > prices[index - 1]) {
      if (consecutiveDown > 0) break;
      consecutiveUp += 1;
    } else if (prices[index] < prices[index - 1]) {
      if (consecutiveUp > 0) break;
      consecutiveDown += 1;
    } else {
      break;
    }
  }
  return { consecutiveUp, consecutiveDown };
}

function confidenceFromSignal(signalBps: bigint, streak: number, observations: number): number {
  const signal = boundedNumber(signalBps < 0n ? -signalBps : signalBps);
  return Math.min(95, 45 + Math.min(30, Math.floor(signal / 20)) + Math.min(15, streak * 5) + Math.min(5, observations));
}

export function computeMarketFeatures(priceHistory: readonly bigint[]): MarketFeatures {
  const prices = priceHistory.filter((price) => price > 0n);
  const observations = prices.length;
  if (observations === 0) {
    return {
      observations: 0,
      regime: "uncertain",
      confidence: 0,
      momentumBps: 0,
      shortSlopeBps: 0,
      longSlopeBps: 0,
      volatilityBps: 0,
      drawdownFromPeakBps: 0,
      latestReturnBps: 0,
      consecutiveUp: 0,
      consecutiveDown: 0,
    };
  }

  const current = prices[observations - 1];
  const short = prices.slice(-Math.min(4, observations));
  const long = prices.slice(-Math.min(12, observations));
  const peak = long.reduce((highest, price) => (price > highest ? price : highest), long[0]);
  const shortSlope = returnBps(short[0], current);
  const longSlope = returnBps(long[0], current);
  const momentum = returnBps(prices[0], current);
  const latestReturn = observations > 1 ? returnBps(prices[observations - 2], current) : 0n;
  const volatility = averageAbsoluteReturns(long);
  const drawdown = returnBps(peak, current);
  const streaks = directionalStreaks(long);

  let regime: MarketRegime = "uncertain";
  let confidence = Math.min(50, observations * 10);
  const absoluteLatest = latestReturn < 0n ? -latestReturn : latestReturn;
  const directionalStreak = Math.max(streaks.consecutiveUp, streaks.consecutiveDown);

  if (
    observations >= 3 &&
    (absoluteLatest >= 1_200n || (absoluteLatest >= 500n && directionalStreak <= 1))
  ) {
    regime = "shock";
    confidence = confidenceFromSignal(absoluteLatest > volatility ? absoluteLatest : volatility, 0, observations);
  } else if (
    observations >= 4 &&
    shortSlope >= 120n &&
    longSlope >= 80n &&
    streaks.consecutiveUp >= 2
  ) {
    regime = "trend_up";
    confidence = confidenceFromSignal(shortSlope + longSlope, streaks.consecutiveUp, observations);
  } else if (
    observations >= 4 &&
    shortSlope <= -120n &&
    longSlope <= -80n &&
    streaks.consecutiveDown >= 2
  ) {
    regime = "trend_down";
    confidence = confidenceFromSignal(shortSlope + longSlope, streaks.consecutiveDown, observations);
  } else if (observations >= 4 && shortSlope < 180n && shortSlope > -180n && longSlope < 250n && longSlope > -250n) {
    regime = "range";
    const rangeSignal = volatility > 20n ? volatility : 20n;
    confidence = Math.min(90, 50 + Math.min(30, Math.floor(boundedNumber(rangeSignal) / 15)) + Math.min(10, observations));
  }

  return {
    observations,
    regime,
    confidence,
    momentumBps: boundedNumber(momentum),
    shortSlopeBps: boundedNumber(shortSlope),
    longSlopeBps: boundedNumber(longSlope),
    volatilityBps: boundedNumber(volatility),
    drawdownFromPeakBps: boundedNumber(drawdown),
    latestReturnBps: boundedNumber(latestReturn),
    consecutiveUp: streaks.consecutiveUp,
    consecutiveDown: streaks.consecutiveDown,
  };
}

export function formatMarketFeatures(features: MarketFeatures): string {
  return [
    `deterministicRegime=${features.regime}`,
    `featureConfidence=${features.confidence}`,
    `momentum=${features.momentumBps}bps`,
    `shortSlope=${features.shortSlopeBps}bps`,
    `longSlope=${features.longSlopeBps}bps`,
    `volatility=${features.volatilityBps}bps`,
    `drawdownFromPeak=${features.drawdownFromPeakBps}bps`,
    `latestReturn=${features.latestReturnBps}bps`,
    `consecutiveUp=${features.consecutiveUp}`,
    `consecutiveDown=${features.consecutiveDown}`,
  ].join(", ");
}
