import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const fromBlock = BigInt(addresses.deployBlock ?? 0);
// Log reads need a wide-range RPC. The public Mantle RPC serves the full deployBlock->latest
// range in bounded chunks. Alchemy's free tier caps eth_getLogs at 10 blocks, so use a
// historical-log-capable endpoint when CHAIN_REPLAY_SOURCE=live. The public Mantle endpoint
// accepts 5,000-block windows, while larger ranges are rejected.
const LOGS_RPC_URL = process.env.LOGS_RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const LOG_CHUNK_SIZE = BigInt(process.env.LOG_CHUNK_SIZE ?? "4999");

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  transport: http(LOGS_RPC_URL),
});

const DECISION_EVENT = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);
const PRICE_SET_EVENT = parseAbiItem("event PriceSet(uint256 price)");
const BOUGHT_EVENT = parseAbiItem("event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price)");
const SOLD_EVENT = parseAbiItem("event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price)");

interface LogCacheEntry {
  logs: any[];
  nextBlock: bigint;
  inFlight?: Promise<any[]>;
}

const logCache = new Map<string, LogCacheEntry>();

export interface DecisionLog {
  nonce: string;
  target: string;
  value: string;
  rationale: string;
  txHash: string;
  block: string;
  timestamp?: string;
  outcome?: string;
  source?: "chain" | "trace";
}

export interface PricePoint {
  block: bigint;
  price: bigint;
}

export interface Trade {
  who: string;
  block: bigint;
  side: "buy" | "sell";
  mntWei: bigint;
  tokenWei: bigint;
  price: bigint;
  txHash: string;
}

function deployed(address: string | undefined): address is `0x${string}` {
  return Boolean(address && address !== ZERO);
}

async function getChunkedLogs<TEvent extends typeof DECISION_EVENT | typeof PRICE_SET_EVENT | typeof BOUGHT_EVENT | typeof SOLD_EVENT>(
  address: `0x${string}`,
  event: TEvent,
) {
  const key = `${address.toLowerCase()}:${event.name}`;
  const existing = logCache.get(key);
  if (existing?.inFlight) return existing.inFlight;

  const entry = existing ?? { logs: [], nextBlock: fromBlock };
  const refresh = (async () => {
    const latest = await client.getBlockNumber();
    if (latest + 1n < entry.nextBlock) {
      entry.logs = [];
      entry.nextBlock = fromBlock;
    }

    // The first request scans deployment history; later refreshes only read new blocks.
    for (let start = entry.nextBlock; start <= latest; start += LOG_CHUNK_SIZE + 1n) {
      const end = start + LOG_CHUNK_SIZE > latest ? latest : start + LOG_CHUNK_SIZE;
      entry.logs.push(...(await client.getLogs({ address, event, fromBlock: start, toBlock: end } as any)));
    }
    entry.nextBlock = latest + 1n;
    return entry.logs;
  })();

  entry.inFlight = refresh;
  logCache.set(key, entry);
  try {
    return await refresh;
  } finally {
    entry.inFlight = undefined;
  }
}

export async function getDecisions(vault?: `0x${string}`): Promise<DecisionLog[]> {
  if (!deployed(vault)) return [];
  const logs = await getChunkedLogs(vault, DECISION_EVENT);
  return logs
    .map((l) => ({
      nonce: l.args.nonce?.toString() ?? "",
      target: l.args.target ?? "",
      value: l.args.value?.toString() ?? "0",
      rationale: l.args.rationale ?? "",
      txHash: l.transactionHash ?? "",
      block: l.blockNumber?.toString() ?? "",
    }))
    .reverse();
}

export async function getPriceHistory(): Promise<PricePoint[]> {
  const dex = addresses.mockDex as `0x${string}`;
  if (!deployed(dex)) return [];
  const logs = await getChunkedLogs(dex, PRICE_SET_EVENT);
  return logs.map((l) => ({
    block: l.blockNumber ?? 0n,
    price: (l.args.price as bigint | undefined) ?? 0n,
  }));
}

export async function getTrades(): Promise<Trade[]> {
  const dex = addresses.mockDex as `0x${string}`;
  if (!deployed(dex)) return [];
  const buys = await getChunkedLogs(dex, BOUGHT_EVENT);
  const sells = await getChunkedLogs(dex, SOLD_EVENT);

  const trades: Trade[] = [
    ...buys.map((l) => ({
      who: (l.args.who as string | undefined) ?? "",
      block: l.blockNumber ?? 0n,
      side: "buy" as const,
      mntWei: (l.args.mntIn as bigint | undefined) ?? 0n,
      tokenWei: (l.args.tokensOut as bigint | undefined) ?? 0n,
      price: (l.args.price as bigint | undefined) ?? 0n,
      txHash: l.transactionHash ?? "",
    })),
    ...sells.map((l) => ({
      who: (l.args.who as string | undefined) ?? "",
      block: l.blockNumber ?? 0n,
      side: "sell" as const,
      mntWei: (l.args.mntOut as bigint | undefined) ?? 0n,
      tokenWei: (l.args.tokensIn as bigint | undefined) ?? 0n,
      price: (l.args.price as bigint | undefined) ?? 0n,
      txHash: l.transactionHash ?? "",
    })),
  ];

  return trades.sort((a, b) => {
    if (a.block === b.block) return a.txHash.localeCompare(b.txHash);
    return a.block < b.block ? -1 : 1;
  });
}
