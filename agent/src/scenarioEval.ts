import "dotenv/config";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { encodeBuy, encodeSell } from "./dex.js";
import { evaluateRisk } from "./risk/engine.js";
import type { RiskLimits } from "./risk/limits.js";
import type { RiskResult } from "./risk/types.js";
import type { SimulationResult } from "./simulation/types.js";
import type { Decision, VaultState } from "./types.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BUY_SELECTOR = encodeBuy().slice(0, 10) as `0x${string}`;
const SELL_SELECTOR = encodeSell(1n).slice(0, 10) as `0x${string}`;

export interface ScenarioInput {
  name: string;
  description?: string;
  target?: `0x${string}`;
  // blockNumber is a runtime observation detail, not part of a risk scenario fixture.
  state: Record<keyof Omit<VaultState, "blockNumber">, string | boolean>;
  decision:
    | { kind: "hold"; rationale?: string }
    | { kind: "buy"; valueWei: string; target?: `0x${string}`; rationale?: string }
    | { kind: "sell"; amountTokenWei: string; target?: `0x${string}`; rationale?: string }
    | {
        kind: "raw";
        target: `0x${string}`;
        valueWei: string;
        calldata: `0x${string}`;
        action?: "pay" | "buy" | "sell";
        amountTokenWei?: string;
        rationale?: string;
      };
  oracle?: {
    pair: string;
    priceWei: string;
    source: "mockdex" | "pyth";
    updatedAt: string;
    stale: boolean;
    maxAgeSeconds: string;
  };
  quotePriceWei?: string;
  simulation?: { ok: boolean; reason?: string };
  allowedTargets?: `0x${string}`[];
  allowedSelectors?: `0x${string}`[];
  limits?: {
    maxDexOracleDeviationBps: string;
    maxPositionBps: string;
    maxTradeValueBps: string;
  };
  expected: {
    ok: boolean;
    ruleId?: string;
  };
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  expected: ScenarioInput["expected"];
  actual: RiskResult;
  description?: string;
}

export interface ScenarioEvalSummary {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

function defaultScenarioDir(env = process.env): string {
  return env.SCENARIO_EVAL_DIR ?? path.join("evals", "scenarios");
}

function defaultScenarioOutput(env = process.env): string | undefined {
  return env.SCENARIO_EVAL_OUTPUT;
}

function asAddress(value: string | undefined, label: string): `0x${string}` {
  if (!value || !ADDRESS_RE.test(value)) throw new Error(`${label} must be a 20-byte hex address`);
  return value as `0x${string}`;
}

function asBigint(value: string | boolean, label: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error(`${label} must be an integer string`);
  return BigInt(value);
}

function parseState(raw: ScenarioInput["state"]): VaultState {
  return {
    balanceWei: asBigint(raw.balanceWei, "state.balanceWei"),
    spendLimitPerTx: asBigint(raw.spendLimitPerTx, "state.spendLimitPerTx"),
    dailyLimit: asBigint(raw.dailyLimit, "state.dailyLimit"),
    spentToday: asBigint(raw.spentToday, "state.spentToday"),
    windowStart: asBigint(raw.windowStart, "state.windowStart"),
    paused: raw.paused === true,
    tokenBalanceWei: asBigint(raw.tokenBalanceWei, "state.tokenBalanceWei"),
    priceWei: asBigint(raw.priceWei, "state.priceWei"),
  };
}

function parseDecision(scenario: ScenarioInput): Decision {
  const fallbackTarget = asAddress(scenario.target, "target");
  const rationale = scenario.decision.rationale ?? scenario.description ?? scenario.name;

  if (scenario.decision.kind === "hold") return { kind: "hold", rationale };
  if (scenario.decision.kind === "buy") {
    return {
      kind: "execute",
      action: "buy",
      target: scenario.decision.target ?? fallbackTarget,
      valueWei: asBigint(scenario.decision.valueWei, "decision.valueWei"),
      calldata: encodeBuy(),
      rationale,
    };
  }
  if (scenario.decision.kind === "sell") {
    const amountTokenWei = asBigint(scenario.decision.amountTokenWei, "decision.amountTokenWei");
    return {
      kind: "execute",
      action: "sell",
      target: scenario.decision.target ?? fallbackTarget,
      valueWei: 0n,
      amountTokenWei,
      calldata: encodeSell(amountTokenWei),
      rationale,
    };
  }

  return {
    kind: "execute",
    action: scenario.decision.action,
    target: scenario.decision.target,
    valueWei: asBigint(scenario.decision.valueWei, "decision.valueWei"),
    amountTokenWei:
      scenario.decision.amountTokenWei === undefined
        ? undefined
        : asBigint(scenario.decision.amountTokenWei, "decision.amountTokenWei"),
    calldata: scenario.decision.calldata,
    rationale,
  };
}

function parseLimits(raw: ScenarioInput["limits"] | undefined): RiskLimits | undefined {
  if (!raw) return undefined;
  return {
    maxDexOracleDeviationBps: asBigint(raw.maxDexOracleDeviationBps, "limits.maxDexOracleDeviationBps"),
    maxPositionBps: asBigint(raw.maxPositionBps, "limits.maxPositionBps"),
    maxTradeValueBps: asBigint(raw.maxTradeValueBps, "limits.maxTradeValueBps"),
  };
}

function parseSimulation(raw: ScenarioInput["simulation"] | undefined): SimulationResult | undefined {
  if (!raw) return undefined;
  return { ok: raw.ok, reason: raw.reason };
}

export function evaluateScenario(scenario: ScenarioInput): ScenarioResult {
  const target = asAddress(scenario.target, "target");
  const actual = evaluateRisk({
    decision: parseDecision(scenario),
    state: parseState(scenario.state),
    allowedTargets: scenario.allowedTargets ?? [target],
    allowedSelectors: scenario.allowedSelectors ?? [BUY_SELECTOR, SELL_SELECTOR],
    oracle: scenario.oracle
      ? {
          pair: scenario.oracle.pair,
          priceWei: asBigint(scenario.oracle.priceWei, "oracle.priceWei"),
          source: scenario.oracle.source,
          updatedAt: asBigint(scenario.oracle.updatedAt, "oracle.updatedAt"),
          stale: scenario.oracle.stale,
          maxAgeSeconds: asBigint(scenario.oracle.maxAgeSeconds, "oracle.maxAgeSeconds"),
        }
      : undefined,
    quotePriceWei: scenario.quotePriceWei ? asBigint(scenario.quotePriceWei, "quotePriceWei") : undefined,
    simulation: parseSimulation(scenario.simulation),
    limits: parseLimits(scenario.limits),
  });

  const okMatches = actual.ok === scenario.expected.ok;
  const ruleMatches = scenario.expected.ruleId === undefined || (!actual.ok && actual.ruleId === scenario.expected.ruleId);
  return {
    name: scenario.name,
    description: scenario.description,
    ok: okMatches && ruleMatches,
    expected: scenario.expected,
    actual,
  };
}

export function evaluateScenarios(scenarios: readonly ScenarioInput[]): ScenarioEvalSummary {
  const results = scenarios.map(evaluateScenario);
  const passed = results.filter((result) => result.ok).length;
  return {
    ok: passed === results.length,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

export async function loadScenarios(dir = defaultScenarioDir()): Promise<ScenarioInput[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8")) as ScenarioInput));
}

export async function runScenarioEval(
  dir = defaultScenarioDir(),
  outputPath = defaultScenarioOutput(),
): Promise<ScenarioEvalSummary> {
  const summary = evaluateScenarios(await loadScenarios(dir));
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  return summary;
}

export async function main(): Promise<void> {
  const dir = process.argv[2] ?? defaultScenarioDir();
  const output = process.argv[3] ?? defaultScenarioOutput();
  const summary = await runScenarioEval(dir, output);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[scenario-eval] failed: ${e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
