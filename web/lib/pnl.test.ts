import { describe, it, expect } from "vitest";
import { buildSeries, currentStanding, START_MNT_WEI, type SeriesPoint } from "./pnl";
import type { PricePoint, Trade } from "./events";

const AI = "0x00000000000000000000000000000000000000A1";
const BL = "0x00000000000000000000000000000000000000B1";
const ONE = 10n ** 18n;

function buy(who: string, block: bigint, mntWei: bigint, tokenWei: bigint, price: bigint): Trade {
  return { who, block, side: "buy", mntWei, tokenWei, price, txHash: "0x" };
}

describe("buildSeries", () => {
  it("leaves both portfolios at the seed when there are no trades", () => {
    const prices: PricePoint[] = [{ block: 5n, price: 2n * ONE }];
    const series = buildSeries(prices, [], AI, BL);
    expect(BigInt(series[0].aiPortfolioWei)).toBe(START_MNT_WEI);
    expect(BigInt(series[0].baselinePortfolioWei)).toBe(START_MNT_WEI);
  });

  it("conserves portfolio value for a buy at the same price (no free gain)", () => {
    // AI spends 0.1 MNT at 2 MNT/token => 0.05 token. At the same price, value is preserved.
    const price = 2n * ONE;
    const trades = [buy(AI, 1n, ONE / 10n, ONE / 20n, price)];
    const prices: PricePoint[] = [{ block: 2n, price }];
    const series = buildSeries(prices, trades, AI, BL);
    expect(BigInt(series[0].aiPortfolioWei)).toBe(ONE); // 0.9 MNT cash + 0.1 MNT token value
    expect(BigInt(series[0].baselinePortfolioWei)).toBe(ONE); // baseline untouched
  });

  it("credits the holder when price rises after a buy", () => {
    const trades = [buy(AI, 1n, ONE / 10n, ONE / 20n, 2n * ONE)];
    const prices: PricePoint[] = [{ block: 2n, price: 3n * ONE }]; // price rose to 3
    const series = buildSeries(prices, trades, AI, BL);
    // 0.9 MNT cash + 0.05 token * 3 = 0.15 => 1.05 MNT
    expect(BigInt(series[0].aiPortfolioWei)).toBe(105n * 10n ** 16n);
  });
});

describe("currentStanding", () => {
  const point = (aiWei: bigint, blWei: bigint): SeriesPoint => ({
    block: "3",
    priceWei: (2n * ONE).toString(),
    aiTokenWei: "0",
    baselineTokenWei: "0",
    aiTokenValueWei: "0",
    baselineTokenValueWei: "0",
    aiPortfolioWei: aiWei.toString(),
    baselinePortfolioWei: blWei.toString(),
  });

  it("names AI the leader and computes ROI/edge in bps", () => {
    const s = currentStanding([point(105n * 10n ** 16n, ONE)]); // AI 1.05, baseline 1.0
    expect(s.leader).toBe("AI");
    expect(s.aiRoiBps).toBe(500n);
    expect(s.baselineRoiBps).toBe(0n);
    expect(s.edgeBps).toBe(500n);
  });

  it("names Baseline the leader when it is ahead", () => {
    const s = currentStanding([point(ONE, 102n * 10n ** 16n)]);
    expect(s.leader).toBe("Baseline");
    expect(s.edgeBps).toBe(-200n);
  });

  it("defaults to a Tie with no series", () => {
    expect(currentStanding([]).leader).toBe("Tie");
  });
});
