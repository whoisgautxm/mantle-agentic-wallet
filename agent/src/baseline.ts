import { parseEther } from "viem";
import { readVaultState, submitExecute, isTargetAllowed, readPrice } from "./chain.js";
import { chain, baselineVaultAddress, dexAddress, getBaselineWalletClient } from "./config.js";
import { createMockDexOracleRouter } from "./oracles/router.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { planToDecision } from "./protocols/types.js";
import { evaluateRisk } from "./risk/engine.js";
import { simulateExecute } from "./simulation/simulator.js";

const DCA_MNT = "0.005";
const protocol = createMockDexAdapter(dexAddress, readPrice);
const oracleRouter = createMockDexOracleRouter(readPrice);

async function tick(): Promise<void> {
  const state = await readVaultState(baselineVaultAddress);
  if (state.paused) {
    console.log("[baseline] paused; skipping");
    return;
  }

  const intent = {
    action: "buy" as const,
    amountMntWei: parseEther(DCA_MNT),
    rationale: `DCA baseline: fixed ${DCA_MNT} MNT buy`,
  };
  const quote = await protocol.quote(intent);
  const plan = protocol.buildPlan(intent, quote);
  const decision = planToDecision(plan, intent.rationale);
  if (decision.kind !== "execute") {
    console.log("[baseline] blocked: adapter produced a non-executable decision");
    return;
  }

  const oracle = await oracleRouter.getPrice("MNT/MOCK");
  const baselineClient = getBaselineWalletClient();
  const simulation = await simulateExecute(baselineVaultAddress, decision, baselineClient.account.address);
  const risk = evaluateRisk({
    decision,
    state,
    allowedTargets: [protocol.target],
    allowedSelectors: protocol.allowedSelectors,
    oracle,
    simulation,
  });
  if (!risk.ok) {
    console.log("[baseline] blocked:", risk.reason);
    return;
  }
  if (!(await isTargetAllowed(baselineVaultAddress, decision.target))) {
    console.log("[baseline] blocked: DEX not allowlisted");
    return;
  }

  const hash = await submitExecute(baselineVaultAddress, decision, baselineClient);
  const base = (chain.blockExplorers?.default.url ?? "").replace(/\/$/, "");
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
