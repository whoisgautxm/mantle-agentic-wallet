import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config as loadDotenv } from "dotenv";
import OpenAI from "openai";
import { formatEther, parseEther } from "viem";
import { decide, normalizeTradeIntent, type ReasoningClient } from "./brain.js";
import { portfolioValueWei, roiBps } from "./pnl.js";
import { createMockDexAdapter } from "./protocols/mockDexAdapter.js";
import { planToDecision, type ProtocolAdapter, type TradeIntent } from "./protocols/types.js";
import { evaluateRisk } from "./risk/engine.js";
import { DEFAULT_RISK_LIMITS } from "./risk/limits.js";
import type { RiskResult } from "./risk/types.js";
import type { Decision, VaultState } from "./types.js";

const DEX = "0x1111111111111111111111111111111111111111" as const;
const ONE = 10n ** 18n;
const BPS = 10_000n;
const MAX_HISTORY = 12;

export interface MarketRegimeFixture {
  id: string;
  label: string;
  description: string;
  prices: string[];
}

export interface MultiRegimeFixture {
  version: 1;
  name: string;
  initialPortfolio: {
    mnt: string;
    token: string;
  };
  baseline: {
    buyMnt: string;
  };
  costs: {
    swapFeeBps: number;
    slippageBps: number;
    gasMnt: string;
  };
  vaultLimits: {
    spendPerTxMnt: string;
    dailySpendMnt: string;
  };
  regimes: MarketRegimeFixture[];
}

interface ParsedFixture {
  name: string;
  initialMntWei: bigint;
  initialTokenWei: bigint;
  baselineBuyWei: bigint;
  costs: BenchmarkCosts;
  spendLimitPerTx: bigint;
  dailyLimit: bigint;
  regimes: Array<Omit<MarketRegimeFixture, "prices"> & { pricesWei: bigint[] }>;
}

export interface BenchmarkCosts {
  swapFeeBps: bigint;
  slippageBps: bigint;
  gasWei: bigint;
}

export interface BenchmarkDecisionInput {
  regimeId: string;
  tickIndex: number;
  state: VaultState;
  priceHistory: bigint[];
  adapter: ProtocolAdapter;
  costs: BenchmarkCosts;
}

export type BenchmarkDecisionRunner = (input: BenchmarkDecisionInput) => Promise<Decision>;

export interface BenchmarkTickResult {
  tick: number;
  priceWei: string;
  action: string;
  outcome: "executed" | "blocked" | "hold" | "error";
  ruleId: string;
  rationale: string;
  portfolioValueWei: string;
  portfolioRoiBps: string;
  cumulativeCostsWei: string;
}

export interface BenchmarkRunnerResult {
  runner: "ai" | "baseline";
  ticks: number;
  executed: number;
  blocked: number;
  held: number;
  errors: number;
  buys: number;
  sells: number;
  turnoverWei: string;
  totalCostsWei: string;
  grossPortfolioValueWei: string;
  netPortfolioValueWei: string;
  grossRoiBps: string;
  netRoiBps: string;
  transactionCostDragBps: string;
  maxDrawdownBps: string;
  timeline: BenchmarkTickResult[];
}

export interface BenchmarkRegimeResult {
  id: string;
  label: string;
  description: string;
  priceStartWei: string;
  priceEndWei: string;
  winner: "ai" | "baseline" | "tie";
  aiEdgeBps: string;
  ai: BenchmarkRunnerResult;
  baseline: BenchmarkRunnerResult;
}

export interface MultiRegimeBenchmarkReport {
  ok: boolean;
  mode: "multi-regime-benchmark";
  fixture: string;
  model: string;
  liveModel: boolean;
  generatedAt: string;
  assumptions: {
    swapFeeBps: string;
    slippageBps: string;
    gasWeiPerExecution: string;
    baselineBuyWei: string;
  };
  aggregate: {
    regimes: number;
    aiWins: number;
    baselineWins: number;
    ties: number;
    aiAverageNetRoiBps: string;
    baselineAverageNetRoiBps: string;
    aiAverageEdgeBps: string;
    aiWorstDrawdownBps: string;
    baselineWorstDrawdownBps: string;
    aiTotalCostsWei: string;
    baselineTotalCostsWei: string;
    modelErrors: number;
  };
  regimes: BenchmarkRegimeResult[];
}

interface MutableAccount {
  state: VaultState;
  initialPortfolioWei: bigint;
  peakPortfolioWei: bigint;
  maxDrawdownBps: bigint;
  costsPaidWei: bigint;
  turnoverWei: bigint;
  executed: number;
  blocked: number;
  held: number;
  errors: number;
  buys: number;
  sells: number;
  timeline: BenchmarkTickResult[];
}

interface SettlementResult {
  outcome: BenchmarkTickResult["outcome"];
  action: string;
  ruleId: string;
  risk?: RiskResult;
}

function workspaceRoot(cwd = process.cwd()): string {
  return path.basename(cwd) === "agent" ? path.dirname(cwd) : cwd;
}

function loadEnv(cwd = process.cwd()): void {
  const root = workspaceRoot(cwd);
  loadDotenv({ path: path.join(root, ".env") });
  loadDotenv({ path: path.join(root, "agent", ".env") });
}

loadEnv();

function defaultFixturePath(): string {
  return path.join("evals", "market-regimes.json");
}

function defaultOutputPath(): string {
  return process.env.MULTI_REGIME_EVAL_OUTPUT ?? path.join("traces", "multi-regime-benchmark.json");
}

function modelName(liveModel: boolean): string {
  return liveModel
    ? process.env.OPENAI_BENCHMARK_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.2"
    : "deterministic-offline";
}

function parseBps(value: number, label: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} must be an integer from 0 to 10000`);
  }
  return BigInt(value);
}

function parseFixture(fixture: MultiRegimeFixture): ParsedFixture {
  if (fixture.version !== 1) throw new Error(`unsupported market-regime fixture version: ${fixture.version}`);
  if (!fixture.regimes.length) throw new Error("market-regime fixture must contain at least one regime");

  const costs = {
    swapFeeBps: parseBps(fixture.costs.swapFeeBps, "costs.swapFeeBps"),
    slippageBps: parseBps(fixture.costs.slippageBps, "costs.slippageBps"),
    gasWei: parseEther(fixture.costs.gasMnt),
  };
  if (costs.swapFeeBps + costs.slippageBps >= BPS) {
    throw new Error("combined swap fee and slippage must be below 10000 bps");
  }

  return {
    name: fixture.name,
    initialMntWei: parseEther(fixture.initialPortfolio.mnt),
    initialTokenWei: parseEther(fixture.initialPortfolio.token),
    baselineBuyWei: parseEther(fixture.baseline.buyMnt),
    costs,
    spendLimitPerTx: parseEther(fixture.vaultLimits.spendPerTxMnt),
    dailyLimit: parseEther(fixture.vaultLimits.dailySpendMnt),
    regimes: fixture.regimes.map((regime) => {
      if (regime.prices.length < 2) throw new Error(`${regime.id} must contain at least two prices`);
      return {
        id: regime.id,
        label: regime.label,
        description: regime.description,
        pricesWei: regime.prices.map((price) => parseEther(price)),
      };
    }),
  };
}

export async function loadMultiRegimeFixture(filePath = defaultFixturePath()): Promise<MultiRegimeFixture> {
  return JSON.parse(await readFile(filePath, "utf8")) as MultiRegimeFixture;
}

function initialState(fixture: ParsedFixture, priceWei: bigint): VaultState {
  return {
    balanceWei: fixture.initialMntWei,
    spendLimitPerTx: fixture.spendLimitPerTx,
    dailyLimit: fixture.dailyLimit,
    spentToday: 0n,
    windowStart: 1_000n,
    paused: false,
    tokenBalanceWei: fixture.initialTokenWei,
    priceWei,
  };
}

function createAccount(fixture: ParsedFixture, priceWei: bigint): MutableAccount {
  const state = initialState(fixture, priceWei);
  const initialPortfolioWei = portfolioValueWei(state.balanceWei, state.tokenBalanceWei, priceWei);
  return {
    state,
    initialPortfolioWei,
    peakPortfolioWei: initialPortfolioWei,
    maxDrawdownBps: 0n,
    costsPaidWei: 0n,
    turnoverWei: 0n,
    executed: 0,
    blocked: 0,
    held: 0,
    errors: 0,
    buys: 0,
    sells: 0,
    timeline: [],
  };
}

function costAdjustedOutput(grossOutput: bigint, costs: BenchmarkCosts): bigint {
  return (grossOutput * (BPS - costs.swapFeeBps - costs.slippageBps)) / BPS;
}

function executionCostWei(grossValueWei: bigint, costs: BenchmarkCosts): bigint {
  return ((grossValueWei * (costs.swapFeeBps + costs.slippageBps)) / BPS) + costs.gasWei;
}

function settleDecision(
  account: MutableAccount,
  decision: Decision,
  adapter: ProtocolAdapter,
  priceWei: bigint,
  costs: BenchmarkCosts,
  nowSeconds: bigint,
): SettlementResult {
  account.state.priceWei = priceWei;
  if (decision.kind === "hold") {
    account.held += 1;
    return { outcome: "hold", action: "hold", ruleId: "NONE" };
  }

  const risk = evaluateRisk({
    decision,
    state: account.state,
    nowSeconds,
    allowedTargets: [adapter.target],
    allowedSelectors: [...adapter.allowedSelectors],
    oracle: {
      pair: "MNT/MOCK",
      priceWei,
      source: "mockdex",
      updatedAt: nowSeconds,
      stale: false,
      maxAgeSeconds: 300n,
    },
    quotePriceWei: priceWei,
    simulation: { ok: true, gasEstimate: 100_000n },
    limits: DEFAULT_RISK_LIMITS,
  });
  if (!risk.ok) {
    account.blocked += 1;
    return { outcome: "blocked", action: decision.action ?? "execute", ruleId: risk.ruleId, risk };
  }

  if (decision.action === "buy") {
    if (decision.valueWei + costs.gasWei > account.state.balanceWei) {
      account.blocked += 1;
      return {
        outcome: "blocked",
        action: "buy",
        ruleId: "INSUFFICIENT_GAS_RESERVE",
      };
    }
    const grossTokenWei = (decision.valueWei * ONE) / priceWei;
    const netTokenWei = costAdjustedOutput(grossTokenWei, costs);
    account.state.balanceWei -= decision.valueWei + costs.gasWei;
    account.state.tokenBalanceWei += netTokenWei;
    account.state.spentToday += decision.valueWei;
    account.turnoverWei += decision.valueWei;
    account.costsPaidWei += executionCostWei(decision.valueWei, costs);
    account.executed += 1;
    account.buys += 1;
    return { outcome: "executed", action: "buy", ruleId: "NONE", risk };
  }

  if (decision.action === "sell") {
    const amountTokenWei = decision.amountTokenWei ?? 0n;
    const grossMntWei = (amountTokenWei * priceWei) / ONE;
    const netMntWei = costAdjustedOutput(grossMntWei, costs);
    if (account.state.balanceWei + netMntWei < costs.gasWei) {
      account.blocked += 1;
      return {
        outcome: "blocked",
        action: "sell",
        ruleId: "INSUFFICIENT_GAS_RESERVE",
      };
    }
    account.state.tokenBalanceWei -= amountTokenWei;
    account.state.balanceWei += netMntWei - costs.gasWei;
    account.turnoverWei += grossMntWei;
    account.costsPaidWei += executionCostWei(grossMntWei, costs);
    account.executed += 1;
    account.sells += 1;
    return { outcome: "executed", action: "sell", ruleId: "NONE", risk };
  }

  account.blocked += 1;
  return { outcome: "blocked", action: decision.action ?? "execute", ruleId: "UNSUPPORTED_ACTION" };
}

function markAccount(account: MutableAccount, tick: number, priceWei: bigint, decision: Decision, settlement: SettlementResult): void {
  const valueWei = portfolioValueWei(account.state.balanceWei, account.state.tokenBalanceWei, priceWei);
  if (valueWei > account.peakPortfolioWei) account.peakPortfolioWei = valueWei;
  const drawdownBps = roiBps(valueWei, account.peakPortfolioWei);
  if (drawdownBps < account.maxDrawdownBps) account.maxDrawdownBps = drawdownBps;
  account.timeline.push({
    tick,
    priceWei: priceWei.toString(),
    action: settlement.action,
    outcome: settlement.outcome,
    ruleId: settlement.ruleId,
    rationale: decision.rationale,
    portfolioValueWei: valueWei.toString(),
    portfolioRoiBps: roiBps(valueWei, account.initialPortfolioWei).toString(),
    cumulativeCostsWei: account.costsPaidWei.toString(),
  });
}

async function buildBaselineDecision(
  account: MutableAccount,
  adapter: ProtocolAdapter,
  amountWei: bigint,
  nowSeconds: bigint,
): Promise<Decision> {
  const normalized = normalizeTradeIntent(
    { action: "buy", amountMntWei: amountWei, rationale: `DCA baseline: fixed ${formatEther(amountWei)} MNT buy` },
    account.state,
    nowSeconds,
  );
  if (normalized.action === "hold") return { kind: "hold", rationale: normalized.rationale };
  const quote = await adapter.quote(normalized);
  return planToDecision(adapter.buildPlan(normalized, quote), normalized.rationale);
}

function finalizeRunner(runner: "ai" | "baseline", account: MutableAccount, finalPriceWei: bigint): BenchmarkRunnerResult {
  const netPortfolioValueWei = portfolioValueWei(account.state.balanceWei, account.state.tokenBalanceWei, finalPriceWei);
  const grossPortfolioValueWei = netPortfolioValueWei + account.costsPaidWei;
  const grossRoi = roiBps(grossPortfolioValueWei, account.initialPortfolioWei);
  const netRoi = roiBps(netPortfolioValueWei, account.initialPortfolioWei);
  return {
    runner,
    ticks: account.timeline.length,
    executed: account.executed,
    blocked: account.blocked,
    held: account.held,
    errors: account.errors,
    buys: account.buys,
    sells: account.sells,
    turnoverWei: account.turnoverWei.toString(),
    totalCostsWei: account.costsPaidWei.toString(),
    grossPortfolioValueWei: grossPortfolioValueWei.toString(),
    netPortfolioValueWei: netPortfolioValueWei.toString(),
    grossRoiBps: grossRoi.toString(),
    netRoiBps: netRoi.toString(),
    transactionCostDragBps: (grossRoi - netRoi).toString(),
    maxDrawdownBps: account.maxDrawdownBps.toString(),
    timeline: account.timeline,
  };
}

async function runRegime(
  fixture: ParsedFixture,
  regime: ParsedFixture["regimes"][number],
  decisionRunner: BenchmarkDecisionRunner,
): Promise<BenchmarkRegimeResult> {
  let currentPrice = regime.pricesWei[0];
  const adapter = createMockDexAdapter(DEX, async () => currentPrice);
  const ai = createAccount(fixture, currentPrice);
  const baseline = createAccount(fixture, currentPrice);
  const priceHistory: bigint[] = [];

  for (let tick = 0; tick < regime.pricesWei.length; tick += 1) {
    currentPrice = regime.pricesWei[tick];
    priceHistory.push(currentPrice);
    if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
    ai.state.priceWei = currentPrice;
    baseline.state.priceWei = currentPrice;
    const nowSeconds = 1_000n + BigInt(tick);

    let aiDecision: Decision;
    let aiSettlement: SettlementResult;
    try {
      aiDecision = await decisionRunner({
        regimeId: regime.id,
        tickIndex: tick,
        state: { ...ai.state },
        priceHistory: [...priceHistory],
        adapter,
        costs: fixture.costs,
      });
      aiSettlement = settleDecision(ai, aiDecision, adapter, currentPrice, fixture.costs, nowSeconds);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
      const message = status === 429 ? "OpenAI rate limit exceeded after benchmark retries." : error instanceof Error ? error.message : String(error);
      ai.errors += 1;
      aiDecision = { kind: "hold", rationale: `Model error: ${message}` };
      aiSettlement = { outcome: "error", action: "hold", ruleId: "MODEL_ERROR" };
    }
    markAccount(ai, tick, currentPrice, aiDecision, aiSettlement);

    const baselineDecision = await buildBaselineDecision(baseline, adapter, fixture.baselineBuyWei, nowSeconds);
    const baselineSettlement = settleDecision(
      baseline,
      baselineDecision,
      adapter,
      currentPrice,
      fixture.costs,
      nowSeconds,
    );
    markAccount(baseline, tick, currentPrice, baselineDecision, baselineSettlement);
  }

  const finalPriceWei = regime.pricesWei[regime.pricesWei.length - 1];
  const aiResult = finalizeRunner("ai", ai, finalPriceWei);
  const baselineResult = finalizeRunner("baseline", baseline, finalPriceWei);
  const aiRoi = BigInt(aiResult.netRoiBps);
  const baselineRoi = BigInt(baselineResult.netRoiBps);
  return {
    id: regime.id,
    label: regime.label,
    description: regime.description,
    priceStartWei: regime.pricesWei[0].toString(),
    priceEndWei: finalPriceWei.toString(),
    winner: aiRoi > baselineRoi ? "ai" : baselineRoi > aiRoi ? "baseline" : "tie",
    aiEdgeBps: (aiRoi - baselineRoi).toString(),
    ai: aiResult,
    baseline: baselineResult,
  };
}

function average(values: bigint[]): bigint {
  if (!values.length) return 0n;
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

function minimum(values: bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

export function createOfflineBenchmarkDecisionRunner(): BenchmarkDecisionRunner {
  return async ({ state, priceHistory, adapter }) => {
    if (priceHistory.length < 2) return { kind: "hold", rationale: "Need at least two observed prices." };
    const current = priceHistory[priceHistory.length - 1];
    const prior = priceHistory.slice(0, -1);
    const recentAverage = average(prior);
    let intent: TradeIntent | { action: "hold"; rationale: string };
    if (current * 100n < recentAverage * 99n) {
      intent = {
        action: "buy",
        amountMntWei: 3n * 10n ** 16n,
        rationale: "Deterministic benchmark strategy bought below the observed average.",
      };
    } else if (current * 100n > recentAverage * 101n && state.tokenBalanceWei > 0n) {
      intent = {
        action: "sell",
        amountTokenWei: (state.tokenBalanceWei * 4n) / 10n,
        rationale: "Deterministic benchmark strategy sold above the observed average.",
      };
    } else {
      intent = { action: "hold", rationale: "Price remained near the observed average." };
    }
    const normalized = normalizeTradeIntent(intent, state, 1_000n);
    if (normalized.action === "hold") return { kind: "hold", rationale: normalized.rationale };
    const quote = await adapter.quote(normalized);
    return planToDecision(adapter.buildPlan(normalized, quote), normalized.rationale);
  };
}

export function createOpenAiBenchmarkDecisionRunner(): BenchmarkDecisionRunner {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for the live multi-regime benchmark");
  const model = modelName(true);
  const client: ReasoningClient = { provider: "openai", openai: new OpenAI({ maxRetries: 0 }) };
  const maxRetries = Number(process.env.OPENAI_BENCHMARK_MAX_RETRIES ?? "8");
  const minimumIntervalMs = Number(
    process.env.OPENAI_BENCHMARK_MIN_INTERVAL_MS ?? (model === "gpt-5.2" ? "21000" : "0"),
  );
  let nextRequestAt = 0;
  return async ({ regimeId, tickIndex, state, priceHistory, adapter, costs }) => {
    if (priceHistory.length < 2) {
      return { kind: "hold", rationale: "Need at least two observed prices before requesting a model decision." };
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const pacingDelay = Math.max(0, nextRequestAt - Date.now());
        if (pacingDelay) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
        nextRequestAt = Date.now() + minimumIntervalMs;
        const decision = await decide(
          client,
          state,
          priceHistory,
          adapter,
          `This is an offline, no-chain-write benchmark. Use only observed prices. Each execution pays ${
            costs.swapFeeBps + costs.slippageBps
          } bps in fee/slippage plus ${formatEther(costs.gasWei)} MNT gas, so avoid low-conviction turnover.`,
          { openAiModel: model },
        );
        console.error(`[multi-regime] ${regimeId} tick ${tickIndex + 1}: ${decision.kind}`);
        return decision;
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
        if (status !== 429 || attempt >= maxRetries) throw error;
        const delayMs = rateLimitDelayMs(error, attempt);
        console.error(
          `[multi-regime] ${regimeId} tick ${tickIndex + 1}: rate limited, retrying in ${Math.ceil(delayMs / 1_000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}

export function rateLimitDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/try again in\s+([\d.]+)\s*(ms|s)/i);
  if (match) {
    const value = Number(match[1]);
    const milliseconds = match[2].toLowerCase() === "ms" ? value : value * 1_000;
    return Math.max(500, Math.ceil(milliseconds + 500));
  }
  const headers = typeof error === "object" && error && "headers" in error ? (error as any).headers : undefined;
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.max(500, Number(retryAfter) * 1_000 + 500);
  const requestReset = headers?.get?.("x-ratelimit-reset-requests");
  const requestResetMatch = typeof requestReset === "string" ? requestReset.match(/^([\d.]+)(ms|s)$/i) : undefined;
  if (requestResetMatch) {
    const value = Number(requestResetMatch[1]);
    return Math.ceil((requestResetMatch[2].toLowerCase() === "ms" ? value : value * 1_000) + 1_000);
  }
  // A full-window cooldown prevents rejected attempts from continuously occupying a low-RPM bucket.
  return Math.max(65_000, Math.min(120_000, 1_000 * 2 ** Math.min(attempt, 7)));
}

export async function runMultiRegimeBenchmark(
  fixtureInput: MultiRegimeFixture,
  decisionRunner: BenchmarkDecisionRunner,
  options: { fixturePath?: string; liveModel?: boolean } = {},
): Promise<MultiRegimeBenchmarkReport> {
  const fixture = parseFixture(fixtureInput);
  const regimes: BenchmarkRegimeResult[] = [];
  for (const regime of fixture.regimes) regimes.push(await runRegime(fixture, regime, decisionRunner));

  const aiRois = regimes.map((regime) => BigInt(regime.ai.netRoiBps));
  const baselineRois = regimes.map((regime) => BigInt(regime.baseline.netRoiBps));
  const aiEdges = regimes.map((regime) => BigInt(regime.aiEdgeBps));
  const aiDrawdowns = regimes.map((regime) => BigInt(regime.ai.maxDrawdownBps));
  const baselineDrawdowns = regimes.map((regime) => BigInt(regime.baseline.maxDrawdownBps));
  const modelErrors = regimes.reduce((total, regime) => total + regime.ai.errors, 0);
  const liveModel = options.liveModel ?? false;
  return {
    ok: modelErrors === 0,
    mode: "multi-regime-benchmark",
    fixture: options.fixturePath ?? fixture.name,
    model: modelName(liveModel),
    liveModel,
    generatedAt: new Date().toISOString(),
    assumptions: {
      swapFeeBps: fixture.costs.swapFeeBps.toString(),
      slippageBps: fixture.costs.slippageBps.toString(),
      gasWeiPerExecution: fixture.costs.gasWei.toString(),
      baselineBuyWei: fixture.baselineBuyWei.toString(),
    },
    aggregate: {
      regimes: regimes.length,
      aiWins: regimes.filter((regime) => regime.winner === "ai").length,
      baselineWins: regimes.filter((regime) => regime.winner === "baseline").length,
      ties: regimes.filter((regime) => regime.winner === "tie").length,
      aiAverageNetRoiBps: average(aiRois).toString(),
      baselineAverageNetRoiBps: average(baselineRois).toString(),
      aiAverageEdgeBps: average(aiEdges).toString(),
      aiWorstDrawdownBps: minimum(aiDrawdowns).toString(),
      baselineWorstDrawdownBps: minimum(baselineDrawdowns).toString(),
      aiTotalCostsWei: regimes
        .reduce((total, regime) => total + BigInt(regime.ai.totalCostsWei), 0n)
        .toString(),
      baselineTotalCostsWei: regimes
        .reduce((total, regime) => total + BigInt(regime.baseline.totalCostsWei), 0n)
        .toString(),
      modelErrors,
    },
    regimes,
  };
}

export async function writeMultiRegimeBenchmark(
  report: MultiRegimeBenchmarkReport,
  outputPath = defaultOutputPath(),
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const positional = args.filter((arg) => arg !== "--offline");
  const fixturePath = positional[0] ?? defaultFixturePath();
  const outputPath = positional[1] ?? defaultOutputPath();
  const fixture = await loadMultiRegimeFixture(fixturePath);
  const report = await runMultiRegimeBenchmark(
    fixture,
    offline ? createOfflineBenchmarkDecisionRunner() : createOpenAiBenchmarkDecisionRunner(),
    { fixturePath, liveModel: !offline },
  );
  await writeMultiRegimeBenchmark(report, outputPath);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as Error;
    console.error(`[multi-regime-eval] failed: ${e.message}`);
    process.exitCode = 1;
  });
}
