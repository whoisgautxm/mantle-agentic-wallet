import { readFile, stat } from "fs/promises";
import path from "path";
import openAiReplaySnapshot from "../data/latest-openai-replay-eval.json";
import scenarioSnapshot from "../data/latest-scenario-summary.json";
import traceSnapshot from "../data/latest-trace-summary.json";

export type EvalReadinessStatus = "ok" | "warn" | "bad";

export interface EvalReadinessMetric {
  label: string;
  value: string;
}

export interface EvalReadinessItem {
  id: string;
  name: string;
  description: string;
  status: EvalReadinessStatus;
  label: string;
  detail: string;
  command: string;
  artifactPath?: string;
  updatedAt?: string;
  metrics: EvalReadinessMetric[];
  findings: string[];
}

export interface EvalReadiness {
  items: EvalReadinessItem[];
}

interface ScenarioSummary {
  ok?: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  results?: Array<{
    name?: string;
    ok?: boolean;
    expected?: { ok?: boolean; ruleId?: string };
    actual?: { ok?: boolean; ruleId?: string; reason?: string };
  }>;
}

interface TraceSummary {
  ok?: boolean;
  totalEvents?: number;
  totalTicks?: number;
  executed?: number;
  blocked?: number;
  held?: number;
  findings?: Array<{
    severity?: string;
    ruleId?: string;
    tickId?: string;
    message?: string;
  }>;
}

interface OpenAiReplaySummary {
  ok?: boolean;
  mode?: string;
  model?: string;
  generatedAt?: string;
  replay?: {
    totalEvents?: number;
    totalTicks?: number;
    runners?: Array<{
      runner?: string;
      ticks?: number;
      executed?: number;
      blocked?: number;
      held?: number;
      portfolioRoiBps?: string;
      maxDrawdownBps?: string;
    }>;
    protocolSignals?: Array<{
      status?: string;
      blocker?: string;
    }>;
  };
  modelReport?: {
    verdict?: "pass" | "watch" | "fail";
    overallScore?: number;
    safetyScore?: number;
    decisionQualityScore?: number;
    evidenceQualityScore?: number;
    aiVsBaselineScore?: number;
    summary?: string;
    aiVsBaseline?: {
      winner?: string;
      rationale?: string;
    };
    findings?: Array<{
      severity?: string;
      ruleId?: string;
      message?: string;
    }>;
    nextActions?: string[];
  };
  findings?: Array<{
    severity?: string;
    ruleId?: string;
    message?: string;
  }>;
}

interface Artifact<T> {
  data: T;
  path: string;
  updatedAt: string;
}

interface MissingArtifact {
  path?: string;
  error?: string;
}

function workspaceRoot(): string {
  return path.basename(process.cwd()) === "web" ? path.dirname(process.cwd()) : process.cwd();
}

function agentPath(root: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(root, "agent", filePath);
}

function displayPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function webDataCandidates(root: string, fileName: string): string[] {
  return [path.join(root, "web", "data", fileName), path.join(root, "data", fileName)];
}

async function readJsonArtifact<T>(
  paths: readonly string[],
  fallback?: Artifact<T>,
): Promise<Artifact<T> | MissingArtifact> {
  let firstParseError: MissingArtifact | undefined;

  for (const filePath of paths) {
    try {
      const raw = await readFile(filePath, "utf8");
      const info = await stat(filePath);
      return {
        data: JSON.parse(raw) as T,
        path: filePath,
        updatedAt: info.mtime.toISOString(),
      };
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") continue;
      firstParseError ??= { path: filePath, error: e.message };
    }
  }

  return firstParseError ?? fallback ?? {};
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function scenarioCandidates(root: string): string[] {
  const configured = process.env.SCENARIO_EVAL_OUTPUT?.trim();
  return [
    ...(configured ? [agentPath(root, configured)] : [path.join(root, "agent", "traces", "scenario-summary.json")]),
    ...webDataCandidates(root, "latest-scenario-summary.json"),
  ];
}

function traceCandidates(root: string): string[] {
  const configured = process.env.TRACE_EVAL_OUTPUT?.trim();
  return [
    ...(configured
      ? [agentPath(root, configured)]
      : [path.join(root, "agent", "traces", "trace-summary.json"), path.join(root, "agent", "traces", "summary.json")]),
    ...webDataCandidates(root, "latest-trace-summary.json"),
  ];
}

function openAiReplayCandidates(root: string): string[] {
  const configured = process.env.OPENAI_REPLAY_EVAL_OUTPUT?.trim();
  return [
    ...(configured ? [agentPath(root, configured)] : [path.join(root, "agent", "traces", "openai-replay-eval.json")]),
    ...webDataCandidates(root, "latest-openai-replay-eval.json"),
  ];
}

function artifactProblem(root: string, artifact: MissingArtifact): Pick<EvalReadinessItem, "artifactPath" | "detail" | "findings"> {
  if (artifact.error) {
    return {
      artifactPath: artifact.path ? displayPath(root, artifact.path) : undefined,
      detail: "Eval artifact exists but could not be parsed.",
      findings: [artifact.error],
    };
  }

  return {
    detail: "No eval summary artifact has been generated yet.",
    findings: [],
  };
}

async function scenarioItem(root: string): Promise<EvalReadinessItem> {
  const artifact = await readJsonArtifact<ScenarioSummary>(scenarioCandidates(root), {
    data: scenarioSnapshot as ScenarioSummary,
    path: path.join(root, "web", "data", "latest-scenario-summary.json"),
    updatedAt: openAiReplaySnapshot.generatedAt,
  });
  const command = "cd agent && npm run eval:scenarios -- evals/scenarios traces/scenario-summary.json";

  if (!("data" in artifact)) {
    const problem = artifactProblem(root, artifact);
    return {
      id: "scenario-evals",
      name: "Scenario evals",
      description: "Deterministic risk scenarios",
      status: artifact.error ? "bad" : "warn",
      label: artifact.error ? "Invalid" : "Not generated",
      detail: problem.detail,
      command,
      artifactPath: problem.artifactPath,
      metrics: [],
      findings: problem.findings,
    };
  }

  const failed = artifact.data.results?.filter((result) => !result.ok) ?? [];
  const total = int(artifact.data.total);
  const passed = int(artifact.data.passed);
  const failedCount = int(artifact.data.failed);

  return {
    id: "scenario-evals",
    name: "Scenario evals",
    description: "Deterministic risk scenarios",
    status: artifact.data.ok ? "ok" : "bad",
    label: artifact.data.ok ? "Passing" : "Failing",
    detail: `${total} scenario(s) replayed against local risk, oracle, selector, target, and simulation gates.`,
    command,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.updatedAt,
    metrics: [
      { label: "Passed", value: passed.toString() },
      { label: "Failed", value: failedCount.toString() },
      { label: "Total", value: total.toString() },
    ],
    findings: failed.slice(0, 4).map((result) => {
      const expected = result.expected?.ruleId ?? String(result.expected?.ok);
      const actual = result.actual?.ruleId ?? String(result.actual?.ok);
      return `${result.name ?? "unnamed"} expected ${expected}, got ${actual}`;
    }),
  };
}

async function traceItem(root: string): Promise<EvalReadinessItem> {
  const artifact = await readJsonArtifact<TraceSummary>(traceCandidates(root), {
    data: traceSnapshot as TraceSummary,
    path: path.join(root, "web", "data", "latest-trace-summary.json"),
    updatedAt: openAiReplaySnapshot.generatedAt,
  });
  const command = "cd agent && npm run eval:traces -- traces/agent-events.jsonl traces/trace-summary.json";

  if (!("data" in artifact)) {
    const problem = artifactProblem(root, artifact);
    return {
      id: "trace-evals",
      name: "Trace evals",
      description: "JSONL policy replay",
      status: artifact.error ? "bad" : "warn",
      label: artifact.error ? "Invalid" : "Not generated",
      detail: problem.detail,
      command,
      artifactPath: problem.artifactPath,
      metrics: [],
      findings: problem.findings,
    };
  }

  const findings = artifact.data.findings ?? [];
  const critical = findings.filter((finding) => finding.severity === "critical").length;

  return {
    id: "trace-evals",
    name: "Trace evals",
    description: "JSONL policy replay",
    status: artifact.data.ok ? "ok" : "bad",
    label: artifact.data.ok ? "Passing" : "Needs review",
    detail: `${int(artifact.data.totalTicks)} tick(s) reconstructed from ${int(artifact.data.totalEvents)} trace event(s).`,
    command,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.updatedAt,
    metrics: [
      { label: "Executed", value: int(artifact.data.executed).toString() },
      { label: "Blocked", value: int(artifact.data.blocked).toString() },
      { label: "Held", value: int(artifact.data.held).toString() },
      { label: "Critical", value: critical.toString() },
    ],
    findings: findings.slice(0, 4).map((finding) => {
      const prefix = finding.tickId ? `${finding.tickId}: ` : "";
      return `${prefix}${finding.ruleId ?? "finding"} - ${finding.message ?? "review trace"}`;
    }),
  };
}

function verdictStatus(summary: OpenAiReplaySummary): EvalReadinessStatus {
  if (summary.ok && summary.modelReport?.verdict === "pass") return "ok";
  if (summary.modelReport?.verdict === "fail" || summary.ok === false) return "bad";
  return "warn";
}

async function openAiReplayItem(root: string): Promise<EvalReadinessItem> {
  const artifact = await readJsonArtifact<OpenAiReplaySummary>(openAiReplayCandidates(root), {
    data: openAiReplaySnapshot as OpenAiReplaySummary,
    path: path.join(root, "web", "data", "latest-openai-replay-eval.json"),
    updatedAt: openAiReplaySnapshot.generatedAt,
  });
  const command = "cd agent && npm run eval:openai-replay -- traces/agent-events.jsonl traces/openai-replay-eval.json";

  if (!("data" in artifact)) {
    const problem = artifactProblem(root, artifact);
    return {
      id: "openai-replay-evals",
      name: "OpenAI replay eval",
      description: "Model-backed agent benchmark",
      status: artifact.error ? "bad" : "warn",
      label: artifact.error ? "Invalid" : "Not generated",
      detail: problem.detail,
      command,
      artifactPath: problem.artifactPath,
      metrics: [],
      findings: problem.findings,
    };
  }

  const modelReport = artifact.data.modelReport ?? {};
  const findings = artifact.data.findings ?? modelReport.findings ?? [];
  const runners = artifact.data.replay?.runners ?? [];
  const ai = runners.find((runner) => runner.runner === "ai");
  const baseline = runners.find((runner) => runner.runner === "baseline");
  const winner = modelReport.aiVsBaseline?.winner ?? "n/a";

  return {
    id: "openai-replay-evals",
    name: "OpenAI replay eval",
    description: "Model-backed agent benchmark",
    status: verdictStatus(artifact.data),
    label: modelReport.verdict === "pass" ? "Passing" : modelReport.verdict === "fail" ? "Failing" : "Watch",
    detail: modelReport.summary ?? `${int(artifact.data.replay?.totalTicks)} replay tick(s) judged by ${artifact.data.model ?? "OpenAI"}.`,
    command,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.data.generatedAt ?? artifact.updatedAt,
    metrics: [
      { label: "Overall", value: int(modelReport.overallScore).toString() },
      { label: "Safety", value: int(modelReport.safetyScore).toString() },
      { label: "Decision", value: int(modelReport.decisionQualityScore).toString() },
      { label: "Evidence", value: int(modelReport.evidenceQualityScore).toString() },
      { label: "AI ROI", value: ai?.portfolioRoiBps ?? "n/a" },
      { label: "Baseline ROI", value: baseline?.portfolioRoiBps ?? "n/a" },
      { label: "Winner", value: winner },
      { label: "Runners", value: runners.length.toString() },
    ],
    findings: findings.slice(0, 4).map((finding) => `${finding.ruleId ?? finding.severity ?? "finding"} - ${finding.message ?? "review report"}`),
  };
}

export async function getEvalReadiness(): Promise<EvalReadiness> {
  const root = workspaceRoot();
  const [scenarios, traces, openAiReplay] = await Promise.all([scenarioItem(root), traceItem(root), openAiReplayItem(root)]);
  return { items: [scenarios, traces, openAiReplay] };
}
