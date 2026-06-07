import type { PricePoint, Trade } from "./events";

// Each vault is seeded with this much MNT at deploy (see contracts/script/Deploy.s.sol).
// Portfolio value is reconstructed from this seed plus on-chain trade flows — no off-chain store.
export const START_MNT_WEI = 10n ** 18n; // 1 MNT

const ONE = 10n ** 18n;

export interface SeriesPoint {
  block: string;
  priceWei: string;
  // token holdings
  aiTokenWei: string;
  baselineTokenWei: string;
  // token leg value (kept for reference)
  aiTokenValueWei: string;
  baselineTokenValueWei: string;
  // TOTAL portfolio value = MNT balance + token value (the fair comparison)
  aiPortfolioWei: string;
  baselinePortfolioWei: string;
}

export interface Standing {
  aiPortfolioWei: bigint;
  baselinePortfolioWei: bigint;
  aiRoiBps: bigint; // basis points vs START_MNT_WEI
  baselineRoiBps: bigint;
  leader: "AI" | "Baseline" | "Tie";
  edgeBps: bigint; // AI minus baseline, in basis points of the baseline
}

export interface OpeningBalances {
  aiMntWei: bigint;
  aiTokenWei: bigint;
  baselineMntWei: bigint;
  baselineTokenWei: bigint;
}

export interface BenchmarkStarts {
  aiPortfolioWei: bigint;
  baselinePortfolioWei: bigint;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function roiBps(current: bigint, start: bigint): bigint {
  if (start === 0n) return 0n;
  return ((current - start) * 10_000n) / start;
}

export function buildSeries(
  prices: PricePoint[],
  trades: Trade[],
  aiVault: string,
  baselineVault: string,
  opening?: OpeningBalances,
): SeriesPoint[] {
  // Reconstruct each vault's MNT balance and token balance from the seed + trade flows.
  // Buy:  MNT -= mntIn (spent),  token += tokensOut.
  // Sell: MNT += mntOut (received), token -= tokensIn.
  let aiMntWei = opening?.aiMntWei ?? START_MNT_WEI;
  let baselineMntWei = opening?.baselineMntWei ?? START_MNT_WEI;
  let aiTokenWei = opening?.aiTokenWei ?? 0n;
  let baselineTokenWei = opening?.baselineTokenWei ?? 0n;
  let tradeIndex = 0;
  const series: SeriesPoint[] = [];

  for (const pricePoint of prices) {
    while (tradeIndex < trades.length && trades[tradeIndex].block <= pricePoint.block) {
      const trade = trades[tradeIndex];
      const isAi = sameAddress(trade.who, aiVault);
      const isBaseline = sameAddress(trade.who, baselineVault);
      if (isAi || isBaseline) {
        const tokenDelta = trade.side === "buy" ? trade.tokenWei : -trade.tokenWei;
        const mntDelta = trade.side === "buy" ? -trade.mntWei : trade.mntWei;
        if (isAi) {
          aiTokenWei += tokenDelta;
          aiMntWei += mntDelta;
        } else {
          baselineTokenWei += tokenDelta;
          baselineMntWei += mntDelta;
        }
      }
      tradeIndex++;
    }

    const aiTokenValue = (aiTokenWei * pricePoint.price) / ONE;
    const baselineTokenValue = (baselineTokenWei * pricePoint.price) / ONE;

    series.push({
      block: pricePoint.block.toString(),
      priceWei: pricePoint.price.toString(),
      aiTokenWei: aiTokenWei.toString(),
      baselineTokenWei: baselineTokenWei.toString(),
      aiTokenValueWei: aiTokenValue.toString(),
      baselineTokenValueWei: baselineTokenValue.toString(),
      aiPortfolioWei: (aiMntWei + aiTokenValue).toString(),
      baselinePortfolioWei: (baselineMntWei + baselineTokenValue).toString(),
    });
  }

  return series;
}

/// Current standing for the scoreboard, derived from the last series point.
export function currentStanding(series: SeriesPoint[], starts?: BenchmarkStarts): Standing {
  const last = series[series.length - 1];
  const ai = last ? BigInt(last.aiPortfolioWei) : START_MNT_WEI;
  const baseline = last ? BigInt(last.baselinePortfolioWei) : START_MNT_WEI;
  const aiRoiBps = roiBps(ai, starts?.aiPortfolioWei ?? START_MNT_WEI);
  const baselineRoiBps = roiBps(baseline, starts?.baselinePortfolioWei ?? START_MNT_WEI);
  const edgeBps = aiRoiBps - baselineRoiBps;
  let leader: Standing["leader"] = "Tie";
  if (aiRoiBps > baselineRoiBps) leader = "AI";
  else if (baselineRoiBps > aiRoiBps) leader = "Baseline";
  return {
    aiPortfolioWei: ai,
    baselinePortfolioWei: baseline,
    aiRoiBps,
    baselineRoiBps,
    leader,
    edgeBps,
  };
}
