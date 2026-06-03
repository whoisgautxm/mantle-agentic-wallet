import { randomUUID } from "crypto";
import { parseEther } from "viem";
import { readVaultState, submitExecute, isTargetAllowed, readPrice } from "./chain.js";
import { chain, baselineVaultAddress, dexAddress, getBaselineWalletClient } from "./config.js";
import { createOracleRouterFromEnv } from "./oracles/router.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { createProtocolRegistry } from "./protocols/registry.js";
import { planToDecision } from "./protocols/types.js";
import { evaluateRisk } from "./risk/engine.js";
import { loadRiskLimitsFromEnv } from "./risk/limits.js";
import { simulateExecute } from "./simulation/simulator.js";
import { createJsonlTraceWriter } from "./tracing.js";

const DCA_MNT = "0.005";
const protocolRegistry = createProtocolRegistry([createMockDexAdapter(dexAddress, readPrice)]);
const protocol = protocolRegistry.requireExecutable("mockdex");
const oracleRouter = createOracleRouterFromEnv(readPrice);
const riskLimits = loadRiskLimitsFromEnv();
const trace = createJsonlTraceWriter();

async function recordTrace(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await trace.append(type, payload);
  } catch (error) {
    const e = error as any;
    console.warn("[baseline trace] write failed:", e?.message ?? "unknown error");
  }
}

async function tick(): Promise<void> {
  const tickId = randomUUID();
  await recordTrace("agent.tick.started", {
    tickId,
    runner: "baseline",
    vault: baselineVaultAddress,
    protocolId: protocol.id,
  });

  const state = await readVaultState(baselineVaultAddress);
  await recordTrace("agent.observation", {
    tickId,
    runner: "baseline",
    vault: baselineVaultAddress,
    state,
  });
  if (state.paused) {
    console.log("[baseline] paused; skipping");
    await recordTrace("agent.final_action", {
      tickId,
      runner: "baseline",
      outcome: "hold",
      reason: "vault paused",
    });
    return;
  }

  const intent = {
    action: "buy" as const,
    amountMntWei: parseEther(DCA_MNT),
    rationale: `DCA baseline: fixed ${DCA_MNT} MNT buy`,
  };
  const quote = await protocol.quote(intent);
  await recordTrace("agent.quote", {
    tickId,
    runner: "baseline",
    protocolId: protocol.id,
    intent,
    quote,
  });
  const plan = protocol.buildPlan(intent, quote);
  const decision = planToDecision(plan, intent.rationale);
  await recordTrace("agent.decision", {
    tickId,
    runner: "baseline",
    intent,
    quote,
    plan,
    decision,
  });
  if (decision.kind !== "execute") {
    console.log("[baseline] blocked: adapter produced a non-executable decision");
    await recordTrace("agent.final_action", {
      tickId,
      runner: "baseline",
      outcome: "blocked",
      reason: "adapter produced a non-executable decision",
      decision,
    });
    return;
  }

  const oracle = await oracleRouter.getPrice("MNT/MOCK");
  if (oracle.warnings?.length) console.warn("[baseline oracle]", oracle.warnings.join("; "));
  await recordTrace("agent.oracle", {
    tickId,
    runner: "baseline",
    oracle,
  });
  const baselineClient = getBaselineWalletClient();
  const simulation = await simulateExecute(baselineVaultAddress, decision, baselineClient.account.address);
  await recordTrace("agent.simulation", {
    tickId,
    runner: "baseline",
    vault: baselineVaultAddress,
    simulation,
  });
  const risk = evaluateRisk({
    decision,
    state,
    allowedTargets: protocolRegistry.allowedTargets(),
    allowedSelectors: protocolRegistry.allowedSelectors(),
    oracle,
    quotePriceWei: quote.priceWei,
    simulation,
    limits: riskLimits,
  });
  await recordTrace("agent.risk", {
    tickId,
    runner: "baseline",
    risk,
    limits: riskLimits,
  });
  if (!risk.ok) {
    console.log("[baseline] blocked:", risk.reason);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "baseline",
      outcome: "blocked",
      reason: risk.reason,
      ruleId: risk.ruleId,
      decision,
    });
    return;
  }
  if (!(await isTargetAllowed(baselineVaultAddress, decision.target))) {
    console.log("[baseline] blocked: DEX not allowlisted");
    await recordTrace("agent.final_action", {
      tickId,
      runner: "baseline",
      outcome: "blocked",
      reason: "DEX not allowlisted",
      decision,
    });
    return;
  }

  const hash = await submitExecute(baselineVaultAddress, decision, baselineClient, { simulation });
  const base = (chain.blockExplorers?.default.url ?? "").replace(/\/$/, "");
  console.log("[baseline executed]", `${base}/tx/${hash}`);
  await recordTrace("agent.final_action", {
    tickId,
    runner: "baseline",
    outcome: "executed",
    txHash: hash,
    decision,
  });
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
        await recordTrace("agent.tick.error", {
          runner: "baseline",
          error: e,
        });
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
