import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import addresses from "../../shared/addresses.json";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const fromBlock = BigInt(addresses.deployBlock ?? 0);

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  transport: http(process.env.MANTLE_RPC_URL),
});

const DECISION_EVENT = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);
const PRICE_SET_EVENT = parseAbiItem("event PriceSet(uint256 price)");
const BOUGHT_EVENT = parseAbiItem("event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price)");
const SOLD_EVENT = parseAbiItem("event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price)");

export interface DecisionLog {
  nonce: string;
  target: string;
  value: string;
  rationale: string;
  txHash: string;
  block: string;
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

export async function getDecisions(vault?: `0x${string}`): Promise<DecisionLog[]> {
  if (!deployed(vault)) return [];
  const logs = await client.getLogs({
    address: vault,
    event: DECISION_EVENT,
    fromBlock,
  });
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
  const logs = await client.getLogs({
    address: dex,
    event: PRICE_SET_EVENT,
    fromBlock,
  });
  return logs.map((l) => ({
    block: l.blockNumber ?? 0n,
    price: (l.args.price as bigint | undefined) ?? 0n,
  }));
}

export async function getTrades(): Promise<Trade[]> {
  const dex = addresses.mockDex as `0x${string}`;
  if (!deployed(dex)) return [];
  const [buys, sells] = await Promise.all([
    client.getLogs({ address: dex, event: BOUGHT_EVENT, fromBlock }),
    client.getLogs({ address: dex, event: SOLD_EVENT, fromBlock }),
  ]);

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
