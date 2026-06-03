import { readFile, stat } from "fs/promises";
import path from "path";

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

async function readJsonArtifact<T>(paths: readonly string[]): Promise<Artifact<T> | MissingArtifact> {
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

  return firstParseError ?? {};
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function scenarioCandidates(root: string): string[] {
  const configured = process.env.SCENARIO_EVAL_OUTPUT?.trim();
  return configured
    ? [agentPath(root, configured)]
    : [path.join(root, "agent", "traces", "scenario-summary.json")];
}

function traceCandidates(root: string): string[] {
  const configured = process.env.TRACE_EVAL_OUTPUT?.trim();
  return configured
    ? [agentPath(root, configured)]
    : [path.join(root, "agent", "traces", "trace-summary.json"), path.join(root, "agent", "traces", "summary.json")];
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
  const artifact = await readJsonArtifact<ScenarioSummary>(scenarioCandidates(root));
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
  const artifact = await readJsonArtifact<TraceSummary>(traceCandidates(root));
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

export async function getEvalReadiness(): Promise<EvalReadiness> {
  const root = workspaceRoot();
  const [scenarios, traces] = await Promise.all([scenarioItem(root), traceItem(root)]);
  return { items: [scenarios, traces] };
}
