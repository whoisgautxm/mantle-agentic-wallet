import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readVaultState, submitExecute, isTargetAllowed, readPrice } from "./chain.js";
import { decide, type ReasoningClient, type ReasoningProvider } from "./brain.js";
import { chain, aiVaultAddress, dexAddress, agentAccount } from "./config.js";
import { createOracleRouterFromEnv } from "./oracles/router.js";
import { portfolioSnapshot, portfolioValueWei, roiBps } from "./pnl.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { createProtocolRegistry } from "./protocols/registry.js";
import { evaluateRisk } from "./risk/engine.js";
import { loadRiskLimitsFromEnv } from "./risk/limits.js";
import { simulateExecute } from "./simulation/simulator.js";
import { sendAlert } from "./telegram.js";
import { createJsonlTraceWriter } from "./tracing.js";

function createReasoningClient(): ReasoningClient {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase() as ReasoningProvider;
  if (provider === "anthropic") {
    return { provider, anthropic: new Anthropic() };
  }
  if (provider === "openai") {
    return { provider, openai: new OpenAI() };
  }
  throw new Error(`unsupported AI_PROVIDER: ${provider}`);
}

const client = createReasoningClient();
const protocolRegistry = createProtocolRegistry([createMockDexAdapter(dexAddress, readPrice)]);
const protocol = protocolRegistry.requireExecutable("mockdex");
const oracleRouter = createOracleRouterFromEnv(readPrice);
const riskLimits = loadRiskLimitsFromEnv();
const PRICE_HISTORY_MAX = 12;
const MAX_DRAWDOWN_BPS = -1500n;
const ESTIMATED_EXECUTION_COST_BPS = Number(process.env.AGENT_ESTIMATED_EXECUTION_COST_BPS ?? "60");
const priceHistory: bigint[] = [];
const trace = createJsonlTraceWriter();
let peakValueWei = 0n;
let benchmarkStartValueWei = 0n;
let breakerTripped = false;

async function recordTrace(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await trace.append(type, payload);
  } catch (error) {
    const e = error as any;
    console.warn("[trace] write failed:", e?.message ?? "unknown error");
  }
}

async function tick(context: string): Promise<void> {
  const tickId = randomUUID();
  await recordTrace("agent.tick.started", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    provider: client.provider,
    protocolId: protocol.id,
  });

  const oracle = await oracleRouter.getPrice("MNT/MOCK");
  if (oracle.warnings?.length) console.warn("[oracle]", oracle.warnings.join("; "));
  priceHistory.push(oracle.priceWei);
  if (priceHistory.length > PRICE_HISTORY_MAX) priceHistory.shift();

  const state = await readVaultState(aiVaultAddress);
  const portfolioValue = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, state.priceWei);
  if (benchmarkStartValueWei === 0n) benchmarkStartValueWei = portfolioValue;
  const portfolio = portfolioSnapshot(state, benchmarkStartValueWei);
  console.log("[state]", {
    mnt: state.balanceWei.toString(),
    token: state.tokenBalanceWei.toString(),
    price: state.priceWei.toString(),
    spentToday: state.spentToday.toString(),
    paused: state.paused,
  });
  await recordTrace("agent.observation", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    oracle,
    state,
    portfolio,
    priceHistory,
  });

  if (state.paused) {
    console.log("[paused] skipping");
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      reason: "vault paused",
      portfolioAfter: portfolio,
    });
    return;
  }

  if (portfolioValue > peakValueWei) peakValueWei = portfolioValue;
  const drawdownBps = roiBps(portfolioValue, peakValueWei);
  if (drawdownBps <= MAX_DRAWDOWN_BPS) {
    if (!breakerTripped) {
      breakerTripped = true;
      console.warn("[breaker] drawdown limit hit; soft-pausing AI trading", {
        portfolioValue: portfolioValue.toString(),
        peakValue: peakValueWei.toString(),
        drawdownBps: drawdownBps.toString(),
      });
    }
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      reason: "drawdown breaker",
      portfolioValue,
      peakValueWei,
      drawdownBps,
      portfolioAfter: portfolio,
    });
    return;
  }

  const adapterTrace: Record<string, unknown> = {};
  const tracedProtocol = {
    ...protocol,
    async quote(intent: Parameters<typeof protocol.quote>[0]) {
      adapterTrace.intent = intent;
      const quote = await protocol.quote(intent);
      adapterTrace.quote = quote;
      await recordTrace("agent.quote", {
        tickId,
        runner: "ai",
        protocolId: protocol.id,
        intent,
        quote,
      });
      return quote;
    },
    buildPlan(intent: Parameters<typeof protocol.buildPlan>[0], quote: Parameters<typeof protocol.buildPlan>[1]) {
      const plan = protocol.buildPlan(intent, quote);
      adapterTrace.plan = plan;
      return plan;
    },
  };

  const decision = await decide(client, state, priceHistory, tracedProtocol, context, {
    estimatedExecutionCostBps: Number.isFinite(ESTIMATED_EXECUTION_COST_BPS)
      ? ESTIMATED_EXECUTION_COST_BPS
      : 60,
  });
  console.log("[decision]", decision.kind, "-", decision.rationale);
  await recordTrace("agent.decision", {
    tickId,
    runner: "ai",
    decision,
    ...adapterTrace,
  });
  if (decision.kind === "hold") {
    await sendAlert(decision);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "hold",
      decision,
      portfolioAfter: portfolio,
    });
    return;
  }

  const simulation = await simulateExecute(aiVaultAddress, decision, agentAccount.address);
  await recordTrace("agent.simulation", {
    tickId,
    runner: "ai",
    vault: aiVaultAddress,
    simulation,
  });
  const risk = evaluateRisk({
    decision,
    state,
    allowedTargets: protocolRegistry.allowedTargets(),
    allowedSelectors: protocolRegistry.allowedSelectors(),
    oracle,
    quotePriceWei: state.priceWei,
    simulation,
    limits: riskLimits,
  });
  const executionPolicy = {
    localTargetAllowed: protocolRegistry.allowedTargets().includes(decision.target),
    localSelectorAllowed: protocolRegistry.allowedSelectors().includes(decision.calldata.slice(0, 10) as `0x${string}`),
  };
  await recordTrace("agent.risk", {
    tickId,
    runner: "ai",
    risk,
    limits: riskLimits,
    executionPolicy,
  });
  if (!risk.ok) {
    console.log("[guard] blocked:", risk.reason);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "blocked",
      reason: risk.reason,
      ruleId: risk.ruleId,
      decision,
      executionPolicy,
      portfolioAfter: portfolio,
    });
    return;
  }

  const onchainTargetAllowed = await isTargetAllowed(aiVaultAddress, decision.target);
  if (!onchainTargetAllowed) {
    console.log("[guard] blocked: target not allowlisted on-chain:", decision.target);
    await recordTrace("agent.final_action", {
      tickId,
      runner: "ai",
      outcome: "blocked",
      reason: "target not allowlisted on-chain",
      decision,
      executionPolicy: { ...executionPolicy, onchainTargetAllowed },
      portfolioAfter: portfolio,
    });
    return;
  }

  const hash = await submitExecute(aiVaultAddress, decision, undefined, { simulation });
  const base = (chain.blockExplorers?.default.url ?? "").replace(/\/$/, "");
  console.log("[executed]", `${base}/tx/${hash}`);
  await sendAlert(decision, hash);
  const stateAfter = await readVaultState(aiVaultAddress);
  const portfolioAfter = portfolioSnapshot(stateAfter, benchmarkStartValueWei);
  await recordTrace("agent.final_action", {
    tickId,
    runner: "ai",
    outcome: "executed",
    txHash: hash,
    decision,
    executionPolicy: { ...executionPolicy, onchainTargetAllowed },
    portfolioBefore: portfolio,
    portfolioAfter,
  });
}

async function main() {
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? "60000");
  const context =
    process.env.AGENT_CONTEXT ??
    "Trade conservatively. Prefer holding unless recent price action gives a clear low-risk edge.";

  console.log("[agent] AI trader starting on", chain.name, "using", client.provider);

  let running = false;
  const loop = async () => {
    if (!running) {
      running = true;
      try {
        await tick(context);
      } catch (e) {
        console.error("[tick error]", e);
        await recordTrace("agent.tick.error", {
          runner: "ai",
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
