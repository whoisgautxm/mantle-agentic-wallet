import { readFile, stat } from "fs/promises";
import path from "path";

export type ProtocolEvidenceStatus = "ok" | "warn" | "bad";

export interface ProtocolEvidenceMetric {
  label: string;
  value: string;
}

export interface ProtocolEvidenceItem {
  id: string;
  name: string;
  description: string;
  status: ProtocolEvidenceStatus;
  label: string;
  detail: string;
  command: string;
  artifactPath?: string;
  updatedAt?: string;
  route: string[];
  metrics: ProtocolEvidenceMetric[];
  findings: string[];
  nextSteps: string[];
}

export interface ProtocolEvidence {
  items: ProtocolEvidenceItem[];
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
  report?: MerchantMoeForkReport;
  quote?: MerchantMoeQuote;
  risk?: MerchantMoeQuoteRisk;
  executionEnabled?: boolean;
}

interface MerchantMoeQuote {
  route?: string[];
  amountIn?: string | number;
  amountOut?: string | number;
  quoter?: string;
  router?: string;
  pairs?: string[];
  binSteps?: Array<string | number>;
  versions?: string[];
  fees?: Array<string | number>;
}

interface MerchantMoeQuoteRisk {
  status?: "unchecked" | "ok" | "blocked";
  reason?: string;
  quotePriceWei?: string | number;
  referencePriceWei?: string | number;
  deviationBps?: string | number;
  maxDeviationBps?: string | number;
  referenceSource?: string;
}

interface MerchantMoeForkReport {
  ok?: boolean;
  executionEnabled?: boolean;
  forkSimulationEnabled?: boolean;
  forkRpcConfigured?: boolean;
  route?: string[];
  amountIn?: string | number;
  amountOut?: string | number;
  expectedOutWei?: string | number;
  minOutWei?: string | number;
  slippageBps?: string | number;
  deadlineSeconds?: string | number;
  quoteRisk?: MerchantMoeQuoteRisk;
  blockers?: Array<{
    ruleId?: string;
    severity?: string;
    reason?: string;
  }>;
  nextSteps?: string[];
}

const readinessCommand = "cd agent && npm run readiness:merchant-moe";

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

function latestMerchantMoeEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "merchant_moe.fork_readiness" || event.type === "merchant_moe.quote_smoke") return event;
  }
  return undefined;
}

function text(value: unknown, fallback = "n/a"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function yesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function short(address: string | undefined): string {
  if (!address) return "n/a";
  if (address.length < 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function routeLabel(route: readonly string[]): string {
  if (!route.length) return "Route not captured";
  return route.map(short).join(" -> ");
}

function quoteRiskStatus(risk: MerchantMoeQuoteRisk | undefined): ProtocolEvidenceStatus {
  if (risk?.status === "blocked") return "bad";
  if (risk?.status === "ok") return "warn";
  return "warn";
}

function forkReadinessStatus(report: MerchantMoeForkReport): ProtocolEvidenceStatus {
  if (report.ok) return "ok";
  if (report.quoteRisk?.status === "blocked") return "bad";
  const blockers = report.blockers ?? [];
  return blockers.some((blocker) => blocker.severity === "critical") ? "bad" : "warn";
}

function findingLabel(blocker: NonNullable<MerchantMoeForkReport["blockers"]>[number]): string {
  const severity = blocker.severity ? `[${blocker.severity}] ` : "";
  const rule = blocker.ruleId ?? "BLOCKER";
  return `${severity}${rule}: ${blocker.reason ?? "review readiness report"}`;
}

function missingItem(root: string, artifact: MissingTraceArtifact): ProtocolEvidenceItem {
  return {
    id: "merchant-moe-evidence",
    name: "Merchant Moe",
    description: "Real DEX quote/readiness trace",
    status: artifact.error ? "bad" : "warn",
    label: artifact.error ? "Invalid trace" : "No trace yet",
    detail: artifact.error
      ? "A trace JSONL file exists but could not be parsed."
      : "Run the Merchant Moe readiness command to generate quote and fork-readiness evidence.",
    command: readinessCommand,
    artifactPath: artifact.path ? displayPath(root, artifact.path) : undefined,
    route: [],
    metrics: [],
    findings: artifact.error ? [artifact.error] : [],
    nextSteps: ["Generate a Merchant Moe readiness trace before presenting the real-protocol path."],
  };
}

function noMerchantEvent(root: string, artifact: TraceArtifact): ProtocolEvidenceItem {
  return {
    id: "merchant-moe-evidence",
    name: "Merchant Moe",
    description: "Real DEX quote/readiness trace",
    status: "warn",
    label: "Not captured",
    detail: "The trace file exists, but it does not include a Merchant Moe quote or fork-readiness event yet.",
    command: readinessCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.updatedAt,
    route: [],
    metrics: [{ label: "Events", value: artifact.events.length.toString() }],
    findings: [],
    nextSteps: ["Run the Merchant Moe readiness command after configuring route and amount env values."],
  };
}

function forkReadinessItem(root: string, artifact: TraceArtifact, event: TraceEvent): ProtocolEvidenceItem {
  const report = event.report ?? {};
  const route = report.route ?? [];
  const risk = report.quoteRisk;
  const blockers = report.blockers ?? [];
  const isReadOnlyBlocked = blockers.some((blocker) => blocker.ruleId === "EXECUTION_CALLDATA_DISABLED");
  const status = forkReadinessStatus(report);

  return {
    id: "merchant-moe-evidence",
    name: "Merchant Moe",
    description: "Mainnet-fork readiness",
    status,
    label: report.ok ? "Ready check" : isReadOnlyBlocked ? "Execution blocked" : "Needs review",
    detail: `${routeLabel(route)}. Quote risk is ${risk?.status ?? "unchecked"}: ${risk?.reason ?? "no risk reason captured"}.`,
    command: readinessCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    route,
    metrics: [
      { label: "Amount in", value: text(report.amountIn) },
      { label: "Expected out", value: text(report.expectedOutWei ?? report.amountOut) },
      { label: "Min out", value: text(report.minOutWei) },
      { label: "Slippage bps", value: text(report.slippageBps) },
      { label: "Deviation bps", value: text(risk?.deviationBps, risk?.status === "unchecked" ? "unchecked" : "n/a") },
      { label: "Fork RPC", value: yesNo(report.forkRpcConfigured) },
      { label: "Fork sim", value: yesNo(report.forkSimulationEnabled) },
      { label: "Execution", value: report.executionEnabled ? "enabled" : "disabled" },
    ],
    findings: blockers.slice(0, 5).map(findingLabel),
    nextSteps: (report.nextSteps ?? []).slice(0, 5),
  };
}

function quoteSmokeItem(root: string, artifact: TraceArtifact, event: TraceEvent): ProtocolEvidenceItem {
  const quote = event.quote ?? {};
  const risk = event.risk;
  const route = quote.route ?? [];

  return {
    id: "merchant-moe-evidence",
    name: "Merchant Moe",
    description: "Read-only quote smoke",
    status: quoteRiskStatus(risk),
    label: risk?.status === "blocked" ? "Quote blocked" : "Quote captured",
    detail: `${routeLabel(route)}. Quote risk is ${risk?.status ?? "unchecked"}: ${risk?.reason ?? "no risk reason captured"}.`,
    command: readinessCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    route,
    metrics: [
      { label: "Amount in", value: text(quote.amountIn) },
      { label: "Amount out", value: text(quote.amountOut) },
      { label: "Deviation bps", value: text(risk?.deviationBps, risk?.status === "unchecked" ? "unchecked" : "n/a") },
      { label: "Reference", value: text(risk?.referenceSource) },
      { label: "Pairs", value: text(quote.pairs?.length ?? 0) },
      { label: "Execution", value: event.executionEnabled ? "enabled" : "disabled" },
    ],
    findings: event.executionEnabled ? [] : ["EXECUTION_CALLDATA_DISABLED: read-only quote evidence only; no swap calldata is built."],
    nextSteps: ["Run fork-readiness after quote smoke to add minOut, slippage, fork RPC, and blocker evidence."],
  };
}

function merchantMoeItem(root: string, artifact: TraceArtifact | MissingTraceArtifact): ProtocolEvidenceItem {
  if (!("events" in artifact)) return missingItem(root, artifact);
  const event = latestMerchantMoeEvent(artifact.events);
  if (!event) return noMerchantEvent(root, artifact);
  if (event.type === "merchant_moe.fork_readiness") return forkReadinessItem(root, artifact, event);
  return quoteSmokeItem(root, artifact, event);
}

export async function getProtocolEvidence(): Promise<ProtocolEvidence> {
  const root = workspaceRoot();
  const artifact = await readTraceArtifact(traceCandidates(root));
  return { items: [merchantMoeItem(root, artifact)] };
}
