import { publicClient, getOwnerWalletClient, dexAddress } from "./config.js";
import { readPrice } from "./chain.js";
import { DEX_ABI } from "./dex.js";

const MIN_PRICE = 5n * 10n ** 17n; // 0.5 MNT/token floor
const MAX_PRICE = 6n * 10n ** 18n; // 6 MNT/token ceiling
const CENTER = 2n * 10n ** 18n; // mean-reversion target

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
  // Volatile random step (±6% in basis points) ...
  const rndBps = BigInt(Math.floor(Math.random() * 1200) - 600); // -600..+599
  let next = current + (current * rndBps) / 10_000n;
  // ... plus 10% mean reversion toward CENTER so the market trends but never sticks at a bound.
  next = next + (CENTER - next) / 10n;
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
