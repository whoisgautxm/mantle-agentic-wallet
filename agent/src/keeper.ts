import { publicClient, getOwnerWalletClient, dexAddress } from "./config.js";
import { readPrice } from "./chain.js";
import { DEX_ABI } from "./dex.js";

const STEP_BPS = 300n; // +/- 3% per tick
const MIN_PRICE = 1n * 10n ** 18n;
const MAX_PRICE = 5n * 10n ** 18n;

async function setPrice(next: bigint): Promise<`0x${string}`> {
  const ownerWalletClient = getOwnerWalletClient();
  const hash = await ownerWalletClient.writeContract({
    address: dexAddress,
    abi: DEX_ABI,
    functionName: "setPrice",
    args: [next],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function tick(): Promise<void> {
  const current = await readPrice();
  const block = await publicClient.getBlock();
  const delta = (current * STEP_BPS) / 10_000n;
  let next = block.timestamp % 2n === 0n ? current + delta : current - delta;
  if (next < MIN_PRICE) next = MIN_PRICE;
  if (next > MAX_PRICE) next = MAX_PRICE;

  const hash = await setPrice(next);
  console.log("[keeper] price", current.toString(), "->", next.toString(), hash);
}

async function main() {
  const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? "45000");
  console.log("[keeper] starting price simulator");

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
