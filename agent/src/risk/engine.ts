import { checkPolicy } from "../policy.js";
import { DEFAULT_RISK_LIMITS } from "./limits.js";
import type { RiskInput, RiskResult } from "./types.js";

function selectorOf(calldata: `0x${string}`): `0x${string}` {
  return calldata.slice(0, 10) as `0x${string}`;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function bps(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator * 10_000n) / denominator;
}

function tokenValueWei(tokenWei: bigint, priceWei: bigint): bigint {
  return (tokenWei * priceWei) / 10n ** 18n;
}

function projectedTokenBalanceWei(input: RiskInput, quotePriceWei: bigint): bigint {
  const { decision, state } = input;
  if (decision.kind === "hold") return state.tokenBalanceWei;
  if (decision.action === "buy") {
    const expectedTokenWei = quotePriceWei > 0n ? (decision.valueWei * 10n ** 18n) / quotePriceWei : 0n;
    return state.tokenBalanceWei + expectedTokenWei;
  }
  if (decision.action === "sell") {
    const sellAmount = decision.amountTokenWei ?? 0n;
    return sellAmount >= state.tokenBalanceWei ? 0n : state.tokenBalanceWei - sellAmount;
  }
  return state.tokenBalanceWei;
}

function tradeValueWei(input: RiskInput, quotePriceWei: bigint): bigint {
  const { decision } = input;
  if (decision.kind === "hold") return 0n;
  if (decision.action === "sell") return tokenValueWei(decision.amountTokenWei ?? 0n, quotePriceWei);
  return decision.valueWei;
}

export function evaluateRisk(input: RiskInput): RiskResult {
  const { decision, state, nowSeconds, allowedTargets, allowedSelectors, oracle, simulation } = input;
  const limits = input.limits ?? DEFAULT_RISK_LIMITS;

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

  const quotePriceWei = input.quotePriceWei ?? state.priceWei;
  if (oracle && quotePriceWei > 0n && oracle.priceWei > 0n) {
    const deviationBps = bps(absDiff(quotePriceWei, oracle.priceWei), oracle.priceWei);
    if (deviationBps > limits.maxDexOracleDeviationBps) {
      return {
        ok: false,
        ruleId: "DEX_ORACLE_DEVIATION",
        reason: `DEX quote deviates ${deviationBps} bps from ${oracle.source} oracle`,
        severity: "critical",
      };
    }
  }

  const portfolioValueWei = state.balanceWei + tokenValueWei(state.tokenBalanceWei, quotePriceWei);
  if (portfolioValueWei > 0n) {
    const projectedTokenWei = projectedTokenBalanceWei(input, quotePriceWei);
    const projectedTokenValueWei = tokenValueWei(projectedTokenWei, quotePriceWei);
    const projectedPositionBps = bps(projectedTokenValueWei, portfolioValueWei);
    if (projectedPositionBps > limits.maxPositionBps) {
      return {
        ok: false,
        ruleId: "MAX_POSITION_SIZE",
        reason: `projected token exposure ${projectedPositionBps} bps exceeds ${limits.maxPositionBps} bps limit`,
        severity: "critical",
      };
    }

    const projectedTradeValueBps = bps(tradeValueWei(input, quotePriceWei), portfolioValueWei);
    if (projectedTradeValueBps > limits.maxTradeValueBps) {
      return {
        ok: false,
        ruleId: "MAX_TRADE_VALUE",
        reason: `trade value ${projectedTradeValueBps} bps exceeds ${limits.maxTradeValueBps} bps portfolio limit`,
        severity: "blocker",
      };
    }
  }

  if (simulation && !simulation.ok) {
    return {
      ok: false,
      ruleId: "SIMULATION_FAILED",
      reason: simulation.reason ?? "execution simulation failed",
      severity: "blocker",
    };
  }

  const warnings = [];
  const projectedTokenWei = projectedTokenBalanceWei(input, quotePriceWei);
  const projectedPortfolioValueWei = state.balanceWei + tokenValueWei(state.tokenBalanceWei, quotePriceWei);
  const projectedPositionBps = bps(tokenValueWei(projectedTokenWei, quotePriceWei), projectedPortfolioValueWei);
  if (projectedPositionBps >= (limits.maxPositionBps * 8n) / 10n) {
    warnings.push({
      ruleId: "POSITION_SIZE_WARNING",
      message: `projected token exposure ${projectedPositionBps} bps is near ${limits.maxPositionBps} bps limit`,
    });
  }

  return { ok: true, warnings };
}
