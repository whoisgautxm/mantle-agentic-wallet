import type { PricePoint, Trade } from "./events";

export interface SeriesPoint {
  block: string;
  priceWei: string;
  aiTokenWei: string;
  baselineTokenWei: string;
  aiTokenValueWei: string;
  baselineTokenValueWei: string;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function buildSeries(
  prices: PricePoint[],
  trades: Trade[],
  aiVault: string,
  baselineVault: string,
): SeriesPoint[] {
  let aiTokenWei = 0n;
  let baselineTokenWei = 0n;
  let tradeIndex = 0;
  const series: SeriesPoint[] = [];

  for (const pricePoint of prices) {
    while (tradeIndex < trades.length && trades[tradeIndex].block <= pricePoint.block) {
      const trade = trades[tradeIndex];
      const tokenDelta = trade.side === "buy" ? trade.tokenWei : -trade.tokenWei;
      if (sameAddress(trade.who, aiVault)) {
        aiTokenWei += tokenDelta;
      } else if (sameAddress(trade.who, baselineVault)) {
        baselineTokenWei += tokenDelta;
      }
      tradeIndex++;
    }

    series.push({
      block: pricePoint.block.toString(),
      priceWei: pricePoint.price.toString(),
      aiTokenWei: aiTokenWei.toString(),
      baselineTokenWei: baselineTokenWei.toString(),
      aiTokenValueWei: ((aiTokenWei * pricePoint.price) / 10n ** 18n).toString(),
      baselineTokenValueWei: ((baselineTokenWei * pricePoint.price) / 10n ** 18n).toString(),
    });
  }

  return series;
}
