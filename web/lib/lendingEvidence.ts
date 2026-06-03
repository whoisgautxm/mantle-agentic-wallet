import { readFile, stat } from "fs/promises";
import path from "path";

export type LendingEvidenceStatus = "ok" | "warn" | "bad";

export interface LendingEvidenceMetric {
  label: string;
  value: string;
}

export interface LendingEvidenceItem {
  id: string;
  name: string;
  description: string;
  status: LendingEvidenceStatus;
  label: string;
  detail: string;
  command: string;
  artifactPath?: string;
  updatedAt?: string;
  metrics: LendingEvidenceMetric[];
  findings: string[];
  nextSteps: string[];
}

export interface LendingEvidence {
  items: LendingEvidenceItem[];
}

interface TraceArtifact {
  events: TraceEvent[];
  path: string;
  updatedAt: string;
}

interface MissingTraceArtifact {
  path?: string;
  error?: string;
}

interface TraceEvent {
  ts?: string;
  type?: string;
  protocolId?: string;
  mode?: string;
  report?: LendingReadinessReport;
}

interface LendingReadinessReport {
  ok?: boolean;
  protocolId?: string;
  mode?: string;
  executionEnabled?: boolean;
  status?: "healthy" | "watch" | "blocked";
  account?: string;
  suppliedValueWei?: string | number;
  debtValueWei?: string | number;
  weightedLiquidationThresholdBps?: string | number;
  collateralAtThresholdWei?: string | number;
  healthFactorBps?: string | number;
  liquidationBufferBps?: string | number;
  marketsChecked?: number;
  assets?: Array<{ symbol?: string }>;
  findings?: Array<{
    ruleId?: string;
    severity?: string;
    reason?: string;
  }>;
  nextSteps?: string[];
}

const readinessCommand = "cd agent && npm run readiness:lending";
const WEI = 10n ** 18n;

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function traceCandidates(root: string): string[] {
  const configured = process.env.TRACE_JSONL_PATH?.trim();
  if (configured) {
    return unique(path.isAbsolute(configured) ? [configured] : [agentPath(root, configured), path.join(root, configured)]);
  }

  const traceDir = process.env.TRACE_DIR?.trim();
  if (traceDir) {
    const traceFile = path.join(traceDir, "agent-events.jsonl");
    return unique(path.isAbsolute(traceFile) ? [traceFile] : [agentPath(root, traceFile), path.join(root, traceFile)]);
  }

  return [path.join(root, "agent", "traces", "agent-events.jsonl")];
}

async function readTraceArtifact(paths: readonly string[]): Promise<TraceArtifact | MissingTraceArtifact> {
  let firstParseError: MissingTraceArtifact | undefined;

  for (const filePath of paths) {
    try {
      const raw = await readFile(filePath, "utf8");
      const info = await stat(filePath);
      const events = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line) as TraceEvent;
          } catch (error) {
            const e = error as Error;
            throw new Error(`line ${index + 1}: ${e.message}`);
          }
        });
      return {
        events,
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

function latestLendingEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "lending.readiness") return event;
  }
  return undefined;
}

function asBigint(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function formatValueWei(value: unknown): string {
  const parsed = asBigint(value);
  if (parsed === undefined) return "n/a";
  const sign = parsed < 0n ? "-" : "";
  const abs = parsed < 0n ? -parsed : parsed;
  const whole = abs / WEI;
  const fraction = (abs % WEI).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""} value`;
}

function formatHealthFactor(value: unknown): string {
  const parsed = asBigint(value);
  if (parsed === undefined) return "no debt";
  return `${(Number(parsed) / 10_000).toFixed(2)}x`;
}

function formatBps(value: unknown): string {
  const parsed = asBigint(value);
  if (parsed === undefined) return "n/a";
  return `${(Number(parsed) / 100).toFixed(2)}%`;
}

function status(report: LendingReadinessReport): LendingEvidenceStatus {
  if (report.status === "blocked" || report.ok === false) return "bad";
  if (report.status === "healthy" && report.ok) return "ok";
  return "warn";
}

function findingLabel(finding: NonNullable<LendingReadinessReport["findings"]>[number]): string {
  const severity = finding.severity ? `[${finding.severity}] ` : "";
  const rule = finding.ruleId ?? "LENDING_FINDING";
  return `${severity}${rule}: ${finding.reason ?? "review lending readiness report"}`;
}

function missingItem(root: string, artifact: MissingTraceArtifact): LendingEvidenceItem {
  return {
    id: "lending-readiness",
    name: "Lendle / INIT",
    description: "Read-only lending health trace",
    status: artifact.error ? "bad" : "warn",
    label: artifact.error ? "Invalid trace" : "No trace yet",
    detail: artifact.error
      ? "A trace JSONL file exists but could not be parsed."
      : "Run the lending readiness command to generate health-factor evidence.",
    command: readinessCommand,
    artifactPath: artifact.path ? displayPath(root, artifact.path) : undefined,
    metrics: [],
    findings: artifact.error ? [artifact.error] : [],
    nextSteps: ["Generate a lending readiness trace before presenting lending or yield-risk capabilities."],
  };
}

function noLendingEvent(root: string, artifact: TraceArtifact): LendingEvidenceItem {
  return {
    id: "lending-readiness",
    name: "Lendle / INIT",
    description: "Read-only lending health trace",
    status: "warn",
    label: "Not captured",
    detail: "The trace file exists, but it does not include a lending readiness event yet.",
    command: readinessCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.updatedAt,
    metrics: [{ label: "Events", value: artifact.events.length.toString() }],
    findings: [],
    nextSteps: ["Run the lending readiness command after configuring read-only position JSON."],
  };
}

function eventItem(root: string, artifact: TraceArtifact, event: TraceEvent): LendingEvidenceItem {
  const report = event.report ?? {};
  const protocol = report.protocolId ?? event.protocolId ?? "lending";
  const findings = report.findings ?? [];
  const label = report.status === "healthy" ? "Healthy" : report.status === "blocked" ? "Blocked" : "Watch";
  const assets = report.assets?.map((asset) => asset.symbol).filter(Boolean).join(", ") || "no assets configured";

  return {
    id: "lending-readiness",
    name: protocol === "init" ? "INIT Capital" : protocol === "lendle" ? "Lendle" : "Lending",
    description: "Read-only lending health trace",
    status: status(report),
    label,
    detail: `${assets}. Lending execution is ${report.executionEnabled ? "enabled" : "disabled"}; this panel is health evidence only.`,
    command: readinessCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    metrics: [
      { label: "Supplied", value: formatValueWei(report.suppliedValueWei) },
      { label: "Debt", value: formatValueWei(report.debtValueWei) },
      { label: "Health factor", value: formatHealthFactor(report.healthFactorBps) },
      { label: "Liq buffer", value: formatBps(report.liquidationBufferBps) },
      { label: "Weighted LT", value: formatBps(report.weightedLiquidationThresholdBps) },
      { label: "Markets", value: String(report.marketsChecked ?? 0) },
    ],
    findings: findings.slice(0, 5).map(findingLabel),
    nextSteps: (report.nextSteps ?? []).slice(0, 5),
  };
}

function item(root: string, artifact: TraceArtifact | MissingTraceArtifact): LendingEvidenceItem {
  if (!("events" in artifact)) return missingItem(root, artifact);
  const event = latestLendingEvent(artifact.events);
  if (!event) return noLendingEvent(root, artifact);
  return eventItem(root, artifact, event);
}

export async function getLendingEvidence(): Promise<LendingEvidence> {
  const root = workspaceRoot();
  const artifact = await readTraceArtifact(traceCandidates(root));
  return { items: [item(root, artifact)] };
}
