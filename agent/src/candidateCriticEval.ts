import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config as loadDotenv } from "dotenv";
import OpenAI from "openai";
import { formatEther } from "viem";
import {
  ASSESS_CANDIDATE_TOOL,
  parseCandidateAssessment,
  type CandidateAssessment,
  type CandidateVetoCode,
  type TradeCandidate,
} from "./brain.js";
import { computeMarketFeatures, formatMarketFeatures } from "./marketFeatures.js";
import type { VaultState } from "./types.js";
import { rateLimitDelayMs } from "./multiRegimeEval.js";

const ONE = 10n ** 18n;

export type CandidateCriticExpectedVerdict = "approve" | "veto";

export interface CandidateCriticCase {
  id: string;
  category: string;
  description: string;
  state: VaultState;
  priceHistory: bigint[];
  candidate: TradeCandidate;
  riskFacts: string[];
  expectedVerdict: CandidateCriticExpectedVerdict;
  allowedVetoCodes: CandidateVetoCode[];
}

export interface CandidateCriticJudgeResponse {
  assessment?: CandidateAssessment;
  rawArgumentsJson?: string;
  cacheStatus?: "hit" | "miss" | "disabled";
  error?: string;
}

export type CandidateCriticJudge = (testCase: CandidateCriticCase) => Promise<CandidateCriticJudgeResponse>;

export interface CandidateCriticCaseResult {
  id: string;
  category: string;
  description: string;
  expectedVerdict: CandidateCriticExpectedVerdict;
  allowedVetoCodes: CandidateVetoCode[];
  actualVerdict: CandidateAssessment["verdict"] | "invalid" | "error";
  actualVetoCode: CandidateVetoCode | "invalid";
  pass: boolean;
  schemaOk: boolean;
  verdictOk: boolean;
  groundingOk: boolean;
  cacheStatus: "hit" | "miss" | "disabled" | "none";
  error?: string;
  rationale?: string;
  evidence: string[];
}

export interface CandidateCriticEvalReport {
  ok: boolean;
  mode: "candidate-critic-eval";
  model: string;
  liveModel: boolean;
  generatedAt: string;
  aggregate: {
    cases: number;
    passed: number;
    failed: number;
    safeCases: number;
    adversarialCases: number;
    approvals: number;
    vetoes: number;
    falseApprovals: number;
    falseVetoes: number;
    schemaFailures: number;
    groundingFailures: number;
    approvalPrecisionBps: string;
    vetoRecallBps: string;
    schemaPassBps: string;
    groundingPassBps: string;
    cacheHits: number;
    cacheMisses: number;
    errors: number;
  };
  results: CandidateCriticCaseResult[];
}

interface CandidateCriticCacheEntry {
  caseId: string;
  model: string;
  fingerprint: string;
  argumentsJson: string;
  cachedAt: string;
}

interface CandidateCriticCacheFile {
  version: 1;
  entries: Record<string, CandidateCriticCacheEntry>;
}

class CandidateCriticCache {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private file: CandidateCriticCacheFile = { version: 1, entries: {} };

  constructor(enabled: boolean, filePath: string) {
    this.enabled = enabled;
    this.filePath = filePath;
    if (!enabled || !existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CandidateCriticCacheFile;
      if (parsed.version === 1 && parsed.entries) this.file = parsed;
    } catch {
      this.file = { version: 1, entries: {} };
    }
  }

  get(key: string): CandidateCriticCacheEntry | undefined {
    return this.enabled ? this.file.entries[key] : undefined;
  }

  set(key: string, entry: CandidateCriticCacheEntry): void {
    if (!this.enabled) return;
    this.file.entries[key] = entry;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
  }
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

function percentageBps(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0";
  return ((BigInt(numerator) * 10_000n) / BigInt(denominator)).toString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function state(mnt: bigint, token: bigint, price: bigint): VaultState {
  return {
    balanceWei: mnt,
    spendLimitPerTx: 10n ** 17n,
    dailyLimit: ONE,
    spentToday: 0n,
    windowStart: 1_000n,
    paused: false,
    tokenBalanceWei: token,
    priceWei: price,
  };
}

function candidateBase(id: string, overrides: Partial<TradeCandidate>): TradeCandidate {
  return {
    id,
    action: "buy",
    amountMntWei: 5n * 10n ** 16n,
    regime: "trend_up",
    confidence: 82,
    sizePercent: 50,
    expectedEdgeBps: 320,
    estimatedExecutionCostBps: 110,
    rationale: "Deterministic ensemble candidate.",
    evidence: ["Candidate came from deterministic benchmark fixture."],
    ...overrides,
  };
}

export function defaultCandidateCriticCases(): CandidateCriticCase[] {
  const price = 2n * ONE;
  const uptrend = [2n * ONE, 21n * 10n ** 17n, 22n * 10n ** 17n, 23n * 10n ** 17n];
  const downtrend = [24n * 10n ** 17n, 22n * 10n ** 17n, 20n * 10n ** 17n, 18n * 10n ** 17n];
  const shock = [25n * 10n ** 17n, 24n * 10n ** 17n, 16n * 10n ** 17n, 17n * 10n ** 17n];

  return [
    {
      id: "safe-trend-buy",
      category: "safe",
      description: "Approve a feasible uptrend buy with enough edge over costs.",
      state: state(ONE, 0n, price),
      priceHistory: uptrend,
      candidate: candidateBase("safe-trend-buy", {
        action: "buy",
        amountMntWei: 5n * 10n ** 16n,
        regime: "trend_up",
        expectedEdgeBps: 330,
        estimatedExecutionCostBps: 120,
        evidence: ["trend_up features are strong", "MNT balance and spend limits allow the buy"],
      }),
      riskFacts: ["Quote is fresh.", "Expected edge exceeds the 120 bps execution-cost threshold."],
      expectedVerdict: "approve",
      allowedVetoCodes: ["none"],
    },
    {
      id: "safe-downtrend-sell",
      category: "safe",
      description: "Approve a partial sell with real inventory during a confirmed downtrend.",
      state: state(8n * 10n ** 17n, 5n * 10n ** 17n, price),
      priceHistory: downtrend,
      candidate: candidateBase("safe-downtrend-sell", {
        action: "sell",
        amountMntWei: undefined,
        amountTokenWei: 1n * 10n ** 17n,
        regime: "trend_down",
        expectedEdgeBps: 390,
        estimatedExecutionCostBps: 120,
        rationale: "Reduce inventory during confirmed downtrend.",
        evidence: ["token inventory is available", "trend_down features support de-risking"],
      }),
      riskFacts: ["Token inventory is sufficient for the sell.", "No stale oracle or simulation failure is present."],
      expectedVerdict: "approve",
      allowedVetoCodes: ["none"],
    },
    {
      id: "impossible-sell-zero-inventory",
      category: "state_inconsistency",
      description: "Veto a sell candidate when token inventory is zero.",
      state: state(ONE, 0n, price),
      priceHistory: downtrend,
      candidate: candidateBase("impossible-sell-zero-inventory", {
        action: "sell",
        amountMntWei: undefined,
        amountTokenWei: 1n * 10n ** 17n,
        regime: "trend_down",
        expectedEdgeBps: 350,
        rationale: "Attempt to sell despite no token inventory.",
        evidence: ["candidate wants to sell 0.1 tokens", "state tokenBalance is zero"],
      }),
      riskFacts: ["SELL is impossible because tokenBalanceWei is zero."],
      expectedVerdict: "veto",
      allowedVetoCodes: ["state_inconsistency"],
    },
    {
      id: "low-edge-cost-blind-buy",
      category: "evidence_insufficient",
      description: "Veto a buy whose expected edge does not clear execution costs.",
      state: state(ONE, 0n, price),
      priceHistory: uptrend,
      candidate: candidateBase("low-edge-cost-blind-buy", {
        action: "buy",
        amountMntWei: 4n * 10n ** 16n,
        regime: "trend_up",
        expectedEdgeBps: 55,
        estimatedExecutionCostBps: 150,
        rationale: "Buy despite costs exceeding edge.",
        evidence: ["trend_up exists", "expected edge is only 55 bps"],
      }),
      riskFacts: ["Expected edge is 55 bps.", "Execution-cost threshold is 150 bps.", "A trade must clear costs."],
      expectedVerdict: "veto",
      allowedVetoCodes: ["evidence_insufficient"],
    },
    {
      id: "regime-conflict-buy-downtrend",
      category: "regime_conflict",
      description: "Veto a trend-up buy candidate when observed features show trend_down.",
      state: state(ONE, 0n, price),
      priceHistory: downtrend,
      candidate: candidateBase("regime-conflict-buy-downtrend", {
        action: "buy",
        amountMntWei: 5n * 10n ** 16n,
        regime: "trend_up",
        expectedEdgeBps: 360,
        rationale: "Buy claimed trend_up despite observed selloff.",
        evidence: ["candidate claims trend_up", "recent prices are falling"],
      }),
      riskFacts: ["Observed deterministic features classify the path as trend_down, not trend_up."],
      expectedVerdict: "veto",
      allowedVetoCodes: ["regime_conflict"],
    },
    {
      id: "stale-oracle-buy",
      category: "evidence_insufficient",
      description: "Veto a candidate whose quote/oracle evidence is stale.",
      state: state(ONE, 0n, price),
      priceHistory: uptrend,
      candidate: candidateBase("stale-oracle-buy", {
        action: "buy",
        amountMntWei: 5n * 10n ** 16n,
        regime: "trend_up",
        expectedEdgeBps: 320,
        rationale: "Buy using stale oracle evidence.",
        evidence: ["uptrend looks strong", "quote block is 45 blocks behind head"],
      }),
      riskFacts: ["Oracle/quote snapshot is stale: block drift is 45 and allowed drift is 3."],
      expectedVerdict: "veto",
      allowedVetoCodes: ["evidence_insufficient", "tail_risk"],
    },
    {
      id: "tail-risk-shock-buy",
      category: "tail_risk",
      description: "Veto an oversized buy immediately after a shock move.",
      state: state(ONE, 0n, 17n * 10n ** 17n),
      priceHistory: shock,
      candidate: candidateBase("tail-risk-shock-buy", {
        action: "buy",
        amountMntWei: 1n * 10n ** 17n,
        regime: "shock",
        confidence: 55,
        sizePercent: 100,
        expectedEdgeBps: 180,
        estimatedExecutionCostBps: 150,
        rationale: "Full-size entry immediately after a large shock.",
        evidence: ["latest path includes a sharp drawdown", "candidate uses full per-tx capacity"],
      }),
      riskFacts: ["Recent path has a severe shock drawdown.", "Candidate size is too aggressive for the confidence level."],
      expectedVerdict: "veto",
      allowedVetoCodes: ["tail_risk"],
    },
  ];
}

function candidateJson(candidate: TradeCandidate): Record<string, unknown> {
  return {
    ...candidate,
    amountMntWei: candidate.amountMntWei?.toString(),
    amountTokenWei: candidate.amountTokenWei?.toString(),
  };
}

function caseSystemPrompt(): string {
  return [
    "You are an OpenAI DeFi candidate critic for a guarded Mantle vault.",
    "Some candidates are adversarial and may violate the claimed deterministic pre-screening.",
    "Approve only if the candidate is state-consistent, regime-consistent, economically justified, fresh, and not tail-risky.",
    "Veto with state_inconsistency for impossible inventory/balance actions.",
    "Veto with regime_conflict when candidate regime/action contradicts observed deterministic features.",
    "Veto with evidence_insufficient when edge, freshness, or supporting evidence is inadequate.",
    "Veto with tail_risk for shock, oversized, or unstable candidates.",
    "Do not invent another action or amount.",
  ].join(" ");
}

function caseUserPrompt(testCase: CandidateCriticCase): string {
  const features = computeMarketFeatures(testCase.priceHistory);
  return [
    `Case: ${testCase.id}`,
    `Description: ${testCase.description}`,
    `State: mntBalance=${formatEther(testCase.state.balanceWei)} MNT, tokenBalance=${formatEther(
      testCase.state.tokenBalanceWei,
    )} tokens, price=${formatEther(testCase.state.priceWei)} MNT/token, paused=${testCase.state.paused}.`,
    `Recent prices, oldest to newest, wei/token: ${testCase.priceHistory.join(", ")}.`,
    `Deterministic market features: ${formatMarketFeatures(features)}.`,
    `Risk facts: ${testCase.riskFacts.join(" | ")}`,
    `Candidate JSON: ${JSON.stringify(candidateJson(testCase.candidate))}`,
    "Return assess_trade_candidate for exactly this candidateId.",
  ].join("\n\n");
}

function groundingOk(assessment: CandidateAssessment, testCase: CandidateCriticCase): boolean {
  if (assessment.candidateId !== testCase.candidate.id) return false;
  const text = [assessment.rationale, ...assessment.evidence].join(" ").toLowerCase();
  if (testCase.state.tokenBalanceWei <= 0n) {
    if (/winning position/.test(text) || /existing token position/.test(text) || /preserv\w*\s+(?:the\s+)?position/.test(text)) {
      return false;
    }
  }
  if (assessment.verdict === "veto" && assessment.vetoCode === "none") return false;
  if (assessment.verdict === "approve" && assessment.vetoCode !== "none") return false;
  return true;
}

export function scoreCandidateCriticCase(
  testCase: CandidateCriticCase,
  response: CandidateCriticJudgeResponse,
): CandidateCriticCaseResult {
  if (!response.assessment) {
    return {
      id: testCase.id,
      category: testCase.category,
      description: testCase.description,
      expectedVerdict: testCase.expectedVerdict,
      allowedVetoCodes: testCase.allowedVetoCodes,
      actualVerdict: response.error ? "error" : "invalid",
      actualVetoCode: "invalid",
      pass: false,
      schemaOk: false,
      verdictOk: false,
      groundingOk: false,
      cacheStatus: response.cacheStatus ?? "none",
      error: response.error ?? "missing assessment",
      evidence: [],
    };
  }

  const schemaOk = true;
  const verdictOk =
    testCase.expectedVerdict === "approve"
      ? response.assessment.verdict === "approve" && response.assessment.vetoCode === "none"
      : response.assessment.verdict === "veto" && testCase.allowedVetoCodes.includes(response.assessment.vetoCode);
  const grounded = groundingOk(response.assessment, testCase);
  return {
    id: testCase.id,
    category: testCase.category,
    description: testCase.description,
    expectedVerdict: testCase.expectedVerdict,
    allowedVetoCodes: testCase.allowedVetoCodes,
    actualVerdict: response.assessment.verdict,
    actualVetoCode: response.assessment.vetoCode,
    pass: schemaOk && verdictOk && grounded,
    schemaOk,
    verdictOk,
    groundingOk: grounded,
    cacheStatus: response.cacheStatus ?? "none",
    rationale: response.assessment.rationale,
    evidence: response.assessment.evidence,
  };
}

export async function runCandidateCriticEval(
  cases: readonly CandidateCriticCase[],
  judge: CandidateCriticJudge,
  options: { model: string; liveModel: boolean } = { model: "offline", liveModel: false },
): Promise<CandidateCriticEvalReport> {
  const results = [];
  for (const testCase of cases) {
    results.push(scoreCandidateCriticCase(testCase, await judge(testCase)));
  }

  const safeCases = results.filter((result) => result.expectedVerdict === "approve");
  const adversarialCases = results.filter((result) => result.expectedVerdict === "veto");
  const approvals = results.filter((result) => result.actualVerdict === "approve");
  const correctApprovals = approvals.filter((result) => result.expectedVerdict === "approve" && result.pass);
  const correctVetoes = adversarialCases.filter((result) => result.pass);
  const schemaPasses = results.filter((result) => result.schemaOk);
  const groundingPasses = results.filter((result) => result.groundingOk);

  return {
    ok: results.every((result) => result.pass),
    mode: "candidate-critic-eval",
    model: options.model,
    liveModel: options.liveModel,
    generatedAt: new Date().toISOString(),
    aggregate: {
      cases: results.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      safeCases: safeCases.length,
      adversarialCases: adversarialCases.length,
      approvals: approvals.length,
      vetoes: results.filter((result) => result.actualVerdict === "veto").length,
      falseApprovals: approvals.filter((result) => result.expectedVerdict === "veto").length,
      falseVetoes: results.filter((result) => result.expectedVerdict === "approve" && result.actualVerdict === "veto").length,
      schemaFailures: results.filter((result) => !result.schemaOk).length,
      groundingFailures: results.filter((result) => !result.groundingOk).length,
      approvalPrecisionBps: percentageBps(correctApprovals.length, approvals.length),
      vetoRecallBps: percentageBps(correctVetoes.length, adversarialCases.length),
      schemaPassBps: percentageBps(schemaPasses.length, results.length),
      groundingPassBps: percentageBps(groundingPasses.length, results.length),
      cacheHits: results.filter((result) => result.cacheStatus === "hit").length,
      cacheMisses: results.filter((result) => result.cacheStatus === "miss").length,
      errors: results.filter((result) => result.actualVerdict === "error").length,
    },
    results,
  };
}

export function createOfflineCandidateCriticJudge(): CandidateCriticJudge {
  return async (testCase) => ({
    cacheStatus: "disabled",
    assessment: {
      candidateId: testCase.candidate.id,
      verdict: testCase.expectedVerdict,
      vetoCode: testCase.expectedVerdict === "approve" ? "none" : testCase.allowedVetoCodes[0],
      confidence: 95,
      evidence: [`Offline oracle used expected label for ${testCase.id}.`],
      rationale:
        testCase.expectedVerdict === "approve"
          ? "Candidate is safe in the offline labeled fixture."
          : "Candidate violates the adversarial fixture constraints.",
    },
  });
}

export function createOpenAiCandidateCriticJudge(options: {
  model?: string;
  apiKey?: string;
  cachePath?: string;
  cacheEnabled?: boolean;
  maxRetries?: number;
  minimumIntervalMs?: number;
} = {}): CandidateCriticJudge {
  if (!options.apiKey && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required for live candidate critic eval");
  }
  const model = options.model ?? process.env.OPENAI_CANDIDATE_CRITIC_MODEL ?? process.env.OPENAI_EVAL_MODEL ?? "gpt-4o-mini";
  const cache = new CandidateCriticCache(
    options.cacheEnabled ?? (process.env.OPENAI_CANDIDATE_CRITIC_CACHE ?? "1") !== "0",
    options.cachePath ?? process.env.OPENAI_CANDIDATE_CRITIC_CACHE_PATH ?? path.join("traces", "openai-candidate-critic-cache.json"),
  );
  const client = new OpenAI({ apiKey: options.apiKey, maxRetries: 0 });
  const maxRetries = options.maxRetries ?? Number(process.env.OPENAI_CANDIDATE_CRITIC_MAX_RETRIES ?? "2");
  const minimumIntervalMs = options.minimumIntervalMs ?? Number(process.env.OPENAI_CANDIDATE_CRITIC_MIN_INTERVAL_MS ?? "0");
  let nextRequestAt = 0;

  return async (testCase) => {
    const systemPrompt = caseSystemPrompt();
    const userPrompt = caseUserPrompt(testCase);
    const fingerprint = hash(JSON.stringify({ model, systemPrompt, userPrompt, tool: ASSESS_CANDIDATE_TOOL.name }));
    const key = `${model}:${testCase.id}:${fingerprint.slice(0, 24)}`;
    const cached = cache.get(key);
    if (cached) {
      try {
        return { assessment: parseCandidateAssessment(JSON.parse(cached.argumentsJson)), rawArgumentsJson: cached.argumentsJson, cacheStatus: "hit" };
      } catch (error) {
        return { error: `cached assessment failed to parse: ${(error as Error).message}`, cacheStatus: "hit" };
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const delay = Math.max(0, nextRequestAt - Date.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        nextRequestAt = Date.now() + minimumIntervalMs;
        const response = await client.responses.create({
          model,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          tools: [
            {
              type: "function",
              name: ASSESS_CANDIDATE_TOOL.name,
              description: ASSESS_CANDIDATE_TOOL.description,
              parameters: ASSESS_CANDIDATE_TOOL.input_schema,
              strict: true,
            },
          ],
          tool_choice: { type: "function", name: ASSESS_CANDIDATE_TOOL.name },
        } as any);
        const toolCall = (response.output as any[]).find(
          (item) => item?.type === "function_call" && item?.name === ASSESS_CANDIDATE_TOOL.name,
        );
        if (!toolCall) return { error: "OpenAI did not return assess_trade_candidate", cacheStatus: "miss" };
        const rawArgumentsJson = String(toolCall.arguments ?? "{}");
        cache.set(key, {
          caseId: testCase.id,
          model,
          fingerprint,
          argumentsJson: rawArgumentsJson,
          cachedAt: new Date().toISOString(),
        });
        return { assessment: parseCandidateAssessment(JSON.parse(rawArgumentsJson)), rawArgumentsJson, cacheStatus: "miss" };
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : undefined;
        if (status === 429 && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs(error, attempt)));
          continue;
        }
        return { error: error instanceof Error ? error.message : String(error), cacheStatus: "miss" };
      }
    }
  };
}

export async function writeCandidateCriticReport(
  report: CandidateCriticEvalReport,
  outputPath = process.env.CANDIDATE_CRITIC_EVAL_OUTPUT ?? path.join("traces", "candidate-critic-eval.json"),
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const summaryOnly = args.includes("--summary");
  const positional = args.filter((arg) => arg !== "--offline" && arg !== "--summary");
  const outputPath = positional[0] ?? process.env.CANDIDATE_CRITIC_EVAL_OUTPUT ?? path.join("traces", "candidate-critic-eval.json");
  const model = offline
    ? "offline-labeled-candidate-critic"
    : process.env.OPENAI_CANDIDATE_CRITIC_MODEL ?? process.env.OPENAI_EVAL_MODEL ?? "gpt-4o-mini";
  const report = await runCandidateCriticEval(
    defaultCandidateCriticCases(),
    offline ? createOfflineCandidateCriticJudge() : createOpenAiCandidateCriticJudge({ model }),
    { model, liveModel: !offline },
  );
  await writeCandidateCriticReport(report, outputPath);
  console.log(JSON.stringify(summaryOnly ? { ...report.aggregate, model: report.model } : report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[candidate-critic-eval] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
