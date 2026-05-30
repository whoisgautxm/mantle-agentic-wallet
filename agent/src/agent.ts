import Anthropic from "@anthropic-ai/sdk";
import { readVaultState, submitExecute, isTargetAllowed } from "./chain.js";
import { decide } from "./brain.js";
import { checkPolicy } from "./policy.js";
import { chain, sinkAddress } from "./config.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

async function tick(context: string): Promise<void> {
  const state = await readVaultState();
  console.log("[state]", {
    balance: state.balanceWei.toString(),
    spentToday: state.spentToday.toString(),
    paused: state.paused,
  });

  const decision = await decide(client, state, context, sinkAddress);
  console.log("[decision]", decision.kind, "-", decision.rationale);

  if (decision.kind === "hold") return;

  const policy = checkPolicy(decision, state);
  if (!policy.ok) {
    console.log("[guard] blocked:", policy.reason);
    return;
  }

  // Mirror the contract's allowlist: skip a target the vault would reject, so we
  // never waste a tx on a "target not allowed" revert.
  if (!(await isTargetAllowed(decision.target))) {
    console.log("[guard] blocked: target not allowlisted on-chain:", decision.target);
    return;
  }

  const hash = await submitExecute(decision);
  const base = chain.blockExplorers?.default.url ?? "";
  console.log("[executed]", `${base}/tx/${hash}`);
}

async function main() {
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? "60000");
  const context =
    process.env.AGENT_CONTEXT ??
    "Market is stable. Maintain the vault. Only act if there is a clear, low-risk reason.";

  console.log("[agent] starting on", chain.name);

  // Chain ticks with setTimeout (not setInterval) + an in-flight guard so a slow tick
  // (LLM call + tx confirmation can exceed the interval) never overlaps the next one —
  // overlapping ticks would race on the account nonce and double-submit.
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
