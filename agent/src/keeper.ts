import { publicClient, getOwnerWalletClient, dexAddress, oracleAddress } from "./config.js";
import { readPrice } from "./chain.js";
import { DEX_ABI } from "./dex.js";
import { applyReturn, scriptedReturnBps, seededReturnBps } from "./priceSequence.js";

const ORACLE_ABI = [
  { type: "function", name: "setPrice", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;
const hasOracle = Boolean(oracleAddress) && oracleAddress !== "0x0000000000000000000000000000000000000000";

const MIN_PRICE = 5n * 10n ** 17n; // 0.5 MNT/token floor
const MAX_PRICE = 6n * 10n ** 18n; // 6 MNT/token ceiling
const CENTER = 2n * 10n ** 18n; // mean-reversion target
const REVERSION_PCT = 10;

// Price mode (live-run report sections 14 & 15): default "walk" is the existing Math.random walk
// (NOT reproducible). "scripted" replays a fixed regime sequence; "seeded" is a deterministic walk.
// Use scripted/seeded for controlled multi-run benchmarks where AI and DCA must face the same market.
const PRICE_MODE = (process.env.KEEPER_PRICE_MODE ?? "walk").toLowerCase();
const KEEPER_SEED = Number(process.env.KEEPER_SEED ?? "20260607");
const MAX_STEP_BPS = Number(process.env.KEEPER_MAX_STEP_BPS ?? "600");
let tickIndex = 0;

function nextReturnBps(): number {
  if (PRICE_MODE === "scripted") return scriptedReturnBps(tickIndex);
  if (PRICE_MODE === "seeded") return seededReturnBps(KEEPER_SEED, tickIndex, MAX_STEP_BPS);
  return Math.floor(Math.random() * (2 * MAX_STEP_BPS)) - MAX_STEP_BPS; // default: non-reproducible walk
}

async function setPrice(next: bigint): Promise<`0x${string}`> {
  const ownerWalletClient = getOwnerWalletClient();
  const hash = await ownerWalletClient.writeContract({
    address: dexAddress,
    abi: DEX_ABI,
    functionName: "setPrice",
    args: [next],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  // Keep the guarded-trade oracle in lockstep with the DEX so honest trades clear the on-chain floor.
  if (hasOracle) {
    const oracleHash = await ownerWalletClient.writeContract({
      address: oracleAddress,
      abi: ORACLE_ABI,
      functionName: "setPrice",
      args: [next],
    });
    await publicClient.waitForTransactionReceipt({ hash: oracleHash });
  }
  return hash;
}

async function tick(): Promise<void> {
  const current = await readPrice();
  const returnBps = nextReturnBps();
  const next = applyReturn({
    prevWei: current,
    returnBps,
    centerWei: CENTER,
    minWei: MIN_PRICE,
    maxWei: MAX_PRICE,
    reversionPct: REVERSION_PCT,
  });
  const hash = await setPrice(next);
  console.log(
    `[keeper] mode=${PRICE_MODE} tick=${tickIndex} ret=${returnBps}bps`,
    current.toString(),
    "->",
    next.toString(),
    hash,
  );
  tickIndex += 1;
}

async function main() {
  const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? "45000");
  console.log("[keeper] starting price simulator", `(mode=${PRICE_MODE}, seed=${KEEPER_SEED})`);

  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try {
        await tick();
      } catch (e) {
        console.error("[keeper error]", e);
      } finally {
        running = false;
      }
    }
    setTimeout(loop, intervalMs);
  };
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
