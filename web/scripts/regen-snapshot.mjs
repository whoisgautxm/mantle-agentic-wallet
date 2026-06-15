// Regenerate web/data/latest-chain-replay.json from the CURRENT deployment's on-chain events,
// so the dashboard's tracked snapshot matches shared/addresses.json (and the README Live Links).
// Run from web/:  node scripts/regen-snapshot.mjs
import { createPublicClient, http, parseAbiItem } from "viem";
import { mantleSepoliaTestnet } from "viem/chains";
import { writeFileSync, readFileSync } from "fs";

const addresses = JSON.parse(readFileSync(new URL("../../shared/addresses.json", import.meta.url)));
const RPC = process.env.LOGS_RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const DEX = addresses.mockDex;
const AI = addresses.aiVault ?? addresses.agentVault;
const BL = addresses.baselineVault;
const FROM = BigInt(addresses.deployBlock ?? 0);
const TO = FROM + 4999n; // the short demo run sits within the first window after deploy

const client = createPublicClient({ chain: mantleSepoliaTestnet, transport: http(RPC) });
const DEC = parseAbiItem(
  "event AgentDecision(uint256 indexed nonce, address indexed target, uint256 value, bytes data, string rationale)",
);
const PS = parseAbiItem("event PriceSet(uint256 price)");
const BUY = parseAbiItem("event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price)");
const SELL = parseAbiItem("event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price)");

const decisions = async (addr) =>
  (await client.getLogs({ address: addr, event: DEC, fromBlock: FROM, toBlock: TO })).map((l) => ({
    nonce: l.args.nonce.toString(),
    target: l.args.target,
    value: l.args.value.toString(),
    rationale: l.args.rationale ?? "",
    txHash: l.transactionHash,
    block: l.blockNumber.toString(),
  }));

const prices = (await client.getLogs({ address: DEX, event: PS, fromBlock: FROM, toBlock: TO })).map((l) => ({
  block: l.blockNumber.toString(),
  price: l.args.price.toString(),
}));
const buys = (await client.getLogs({ address: DEX, event: BUY, fromBlock: FROM, toBlock: TO })).map((l) => ({
  who: l.args.who,
  block: l.blockNumber.toString(),
  side: "buy",
  mntWei: l.args.mntIn.toString(),
  tokenWei: l.args.tokensOut.toString(),
  price: l.args.price.toString(),
  txHash: l.transactionHash,
}));
const sells = (await client.getLogs({ address: DEX, event: SELL, fromBlock: FROM, toBlock: TO })).map((l) => ({
  who: l.args.who,
  block: l.blockNumber.toString(),
  side: "sell",
  mntWei: l.args.mntOut.toString(),
  tokenWei: l.args.tokensIn.toString(),
  price: l.args.price.toString(),
  txHash: l.transactionHash,
}));
const trades = [...buys, ...sells].sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : 1));

const snapshot = {
  generatedAt: new Date().toISOString(),
  source: "Mantle Sepolia eth_getLogs (current guarded + oracle deployment)",
  fromBlock: FROM.toString(),
  toBlock: TO.toString(),
  aiDecisions: await decisions(AI),
  baselineDecisions: await decisions(BL),
  prices,
  trades,
  opening: { aiMntWei: (10n ** 18n).toString(), aiTokenWei: "0", baselineMntWei: (10n ** 18n).toString(), baselineTokenWei: "0" },
};

writeFileSync(new URL("../data/latest-chain-replay.json", import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log("snapshot regenerated:", {
  vaults: { ai: AI, baseline: BL, dex: DEX },
  blocks: `${snapshot.fromBlock}-${snapshot.toBlock}`,
  prices: prices.length,
  trades: trades.length,
  aiDecisions: snapshot.aiDecisions.length,
  baselineDecisions: snapshot.baselineDecisions.length,
});
