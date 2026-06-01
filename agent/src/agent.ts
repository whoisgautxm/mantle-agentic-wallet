import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readVaultState, submitExecute, isTargetAllowed, readPrice } from "./chain.js";
import { decide, type ReasoningClient, type ReasoningProvider } from "./brain.js";
import { checkPolicy } from "./policy.js";
import { chain, aiVaultAddress, dexAddress } from "./config.js";
import { portfolioValueWei, roiBps } from "./pnl.js";
import { sendAlert } from "./telegram.js";

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
const PRICE_HISTORY_MAX = 12;
const MAX_DRAWDOWN_BPS = -1500n;
const priceHistory: bigint[] = [];
let peakValueWei = 0n;
let breakerTripped = false;

async function tick(context: string): Promise<void> {
  const price = await readPrice();
  priceHistory.push(price);
  if (priceHistory.length > PRICE_HISTORY_MAX) priceHistory.shift();

  const state = await readVaultState(aiVaultAddress);
  console.log("[state]", {
    mnt: state.balanceWei.toString(),
    token: state.tokenBalanceWei.toString(),
    price: state.priceWei.toString(),
    spentToday: state.spentToday.toString(),
    paused: state.paused,
  });

  if (state.paused) {
    console.log("[paused] skipping");
    return;
  }

  const portfolioValue = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, state.priceWei);
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
    return;
  }

  const decision = await decide(client, state, priceHistory, dexAddress, context);
  console.log("[decision]", decision.kind, "-", decision.rationale);
  if (decision.kind === "hold") {
    await sendAlert(decision);
    return;
  }

  const policy = checkPolicy(decision, state);
  if (!policy.ok) {
    console.log("[guard] blocked:", policy.reason);
    return;
  }

  if (!(await isTargetAllowed(aiVaultAddress, decision.target))) {
    console.log("[guard] blocked: target not allowlisted on-chain:", decision.target);
    return;
  }

  const hash = await submitExecute(aiVaultAddress, decision);
  const base = (chain.blockExplorers?.default.url ?? "").replace(/\/$/, "");
  console.log("[executed]", `${base}/tx/${hash}`);
  await sendAlert(decision, hash);
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
