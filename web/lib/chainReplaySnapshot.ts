import snapshot from "../data/latest-chain-replay.json";
import type { DecisionLog, PricePoint, Trade } from "./events";
import type { OpeningBalances } from "./pnl";

export interface ChainReplaySnapshot {
  generatedAt: string;
  source: string;
  fromBlock: string;
  toBlock: string;
  aiDecisions: DecisionLog[];
  baselineDecisions: DecisionLog[];
  prices: PricePoint[];
  trades: Trade[];
  opening: OpeningBalances;
}

export function getChainReplaySnapshot(): ChainReplaySnapshot {
  return {
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    fromBlock: snapshot.fromBlock,
    toBlock: snapshot.toBlock,
    aiDecisions: snapshot.aiDecisions,
    baselineDecisions: snapshot.baselineDecisions,
    prices: snapshot.prices.map((point) => ({
      block: BigInt(point.block),
      price: BigInt(point.price),
    })),
    trades: snapshot.trades.map((trade) => ({
      ...trade,
      block: BigInt(trade.block),
      mntWei: BigInt(trade.mntWei),
      tokenWei: BigInt(trade.tokenWei),
      price: BigInt(trade.price),
      side: trade.side as "buy" | "sell",
    })),
    opening: {
      aiMntWei: BigInt(snapshot.opening.aiMntWei),
      aiTokenWei: BigInt(snapshot.opening.aiTokenWei),
      baselineMntWei: BigInt(snapshot.opening.baselineMntWei),
      baselineTokenWei: BigInt(snapshot.opening.baselineTokenWei),
    },
  };
}
