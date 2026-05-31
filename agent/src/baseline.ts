import { parseEther } from "viem";
import { readVaultState, submitExecute, isTargetAllowed } from "./chain.js";
import { encodeBuy } from "./dex.js";
import { checkPolicy } from "./policy.js";
import { chain, baselineVaultAddress, dexAddress, getBaselineWalletClient } from "./config.js";
import type { Decision } from "./types.js";

const DCA_MNT = "0.005";

async function tick(): Promise<void> {
  const state = await readVaultState(baselineVaultAddress);
  if (state.paused) {
    console.log("[baseline] paused; skipping");
    return;
  }

  const decision: Decision = {
    kind: "execute",
    action: "buy",
    target: dexAddress,
    valueWei: parseEther(DCA_MNT),
    calldata: encodeBuy(),
    rationale: `DCA baseline: fixed ${DCA_MNT} MNT buy`,
  };

  const policy = checkPolicy(decision, state);
  if (!policy.ok) {
    console.log("[baseline] blocked:", policy.reason);
    return;
  }
  if (!(await isTargetAllowed(baselineVaultAddress, decision.target))) {
    console.log("[baseline] blocked: DEX not allowlisted");
    return;
  }

  const hash = await submitExecute(baselineVaultAddress, decision, getBaselineWalletClient());
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[baseline executed]", `${base}/tx/${hash}`);
}

async function main() {
  const intervalMs = Number(process.env.BASELINE_INTERVAL_MS ?? "60000");
  console.log("[baseline] DCA runner starting on", chain.name);

  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try {
        await tick();
      } catch (e) {
        console.error("[baseline error]", e);
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
