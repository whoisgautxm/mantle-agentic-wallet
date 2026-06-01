import { checkPolicy } from "../policy.js";
import type { RiskInput, RiskResult } from "./types.js";

function selectorOf(calldata: `0x${string}`): `0x${string}` {
  return calldata.slice(0, 10) as `0x${string}`;
}

export function evaluateRisk(input: RiskInput): RiskResult {
  const { decision, state, nowSeconds, allowedTargets, allowedSelectors, oracle, simulation } = input;

  if (decision.kind === "hold") return { ok: true, warnings: [] };

  const policy = checkPolicy(decision, state, nowSeconds);
  if (!policy.ok) {
    return {
      ok: false,
      ruleId: "POLICY_PRECHECK",
      reason: policy.reason ?? "policy precheck failed",
      severity: "blocker",
    };
  }

  if (allowedTargets && !allowedTargets.includes(decision.target)) {
    return {
      ok: false,
      ruleId: "TARGET_NOT_ALLOWED",
      reason: `target ${decision.target} is not in the local adapter allowlist`,
      severity: "critical",
    };
  }

  const selector = selectorOf(decision.calldata);
  if (allowedSelectors && !allowedSelectors.includes(selector)) {
    return {
      ok: false,
      ruleId: "FUNCTION_NOT_ALLOWED",
      reason: `selector ${selector} is not allowed for this adapter`,
      severity: "critical",
    };
  }

  if (oracle?.stale) {
    return {
      ok: false,
      ruleId: "ORACLE_STALE",
      reason: `${oracle.pair} price from ${oracle.source} is stale`,
      severity: "critical",
    };
  }

  if (simulation && !simulation.ok) {
    return {
      ok: false,
      ruleId: "SIMULATION_FAILED",
      reason: simulation.reason ?? "execution simulation failed",
      severity: "blocker",
    };
  }

  return { ok: true, warnings: [] };
}
