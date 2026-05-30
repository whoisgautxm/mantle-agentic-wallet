import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
// Next.js resolves JSON imports natively — no import attribute needed.
import addresses from "../../shared/addresses.json";

const client = createPublicClient({
  chain: mantleSepoliaTestnet,
  // Falls back to the chain's default RPC if MANTLE_RPC_URL is unset.
  transport: http(process.env.MANTLE_RPC_URL),
});

const DECISION_EVENT = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);

export interface DecisionLog {
  nonce: string;
  target: string;
  value: string;
  rationale: string;
  txHash: string;
}

export async function getDecisions(): Promise<DecisionLog[]> {
  // Query from the deploy block (recorded at deploy time), NOT "earliest" —
  // public Mantle RPCs cap eth_getLogs block ranges and reject genesis-to-latest scans.
  const logs = await client.getLogs({
    address: addresses.agentVault as `0x${string}`,
    event: DECISION_EVENT,
    fromBlock: BigInt(addresses.deployBlock ?? 0),
  });
  return logs
    .map((l) => ({
      nonce: l.args.nonce?.toString() ?? "",
      target: l.args.target ?? "",
      value: l.args.value?.toString() ?? "0",
      rationale: l.args.rationale ?? "",
      txHash: l.transactionHash ?? "",
    }))
    .reverse();
}
