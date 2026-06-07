import { readFile, stat } from "fs/promises";
import path from "path";
import { protocolEvidenceSnapshot } from "./protocolEvidenceSnapshot";

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
  report?: MerchantMoeForkReport | MerchantMoeForkSimulationReport | MerchantMoeAdversarialSuiteReport;
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

interface MerchantMoeForkSimulationReport {
  ok?: boolean;
  fixtureMode?: boolean;
  fixtureKind?: "deterministic" | "anvil-mainnet-fork";
  forkBlockNumber?: string | number;
  setupTransactionHashes?: string[];
  executionEnabled?: boolean;
  forkRpcConfigured?: boolean;
  forkSimulationEnabled?: boolean;
  simulationAttempted?: boolean;
  simulationPassed?: boolean;
  simulationMode?: string;
  target?: string;
  from?: string;
  vault?: string;
  valueWei?: string | number;
  calldataBytes?: number;
  route?: string[];
  amountIn?: string | number;
  expectedOutWei?: string | number;
  minOutWei?: string | number;
  slippageBps?: string | number;
  quoteRisk?: MerchantMoeQuoteRisk;
  simulation?: {
    ok?: boolean;
    gasEstimate?: string | number;
    reason?: string;
    revertReason?: string;
    warnings?: string[];
  };
  vaultEvidence?: {
    address?: string;
    routerAllowed?: boolean;
    tokenAllowed?: boolean;
    paused?: boolean;
  };
  forkExecution?: {
    attempted?: boolean;
    passed?: boolean;
    transactionHash?: string;
    gasUsed?: string | number;
    agentDecisionEvents?: string | number;
    tokenOutDelta?: string | number;
    reason?: string;
  };
  findings?: Array<{
    ruleId?: string;
    severity?: string;
    reason?: string;
  }>;
  nextSteps?: string[];
}

interface MerchantMoeAdversarialScenario {
  id?: string;
  label?: string;
  stage?: string;
  expectedRuleId?: string;
  observedRuleId?: string;
  passed?: boolean;
  simulationAttempted?: boolean;
  swapTransactionSubmitted?: boolean;
  reason?: string;
}

interface MerchantMoeAdversarialSuiteReport {
  ok?: boolean;
  executionEnabled?: boolean;
  forkBlockNumber?: string | number;
  route?: string[];
  amountIn?: string | number;
  expectedOutWei?: string | number;
  totalScenarios?: number;
  passedScenarios?: number;
  failedScenarios?: number;
  noUnsafeSwapTransactionsSubmitted?: boolean;
  scenarios?: MerchantMoeAdversarialScenario[];
  nextSteps?: string[];
}

const readinessCommand = "cd agent && npm run readiness:merchant-moe";
const simulationCommand = "cd agent && npm run simulate:merchant-moe-fork";
const fixtureCommand = "cd agent && npm run simulate:merchant-moe-fixture";
const anvilCommand = "cd agent && npm run simulate:merchant-moe-anvil";
const adversarialCommand = "cd agent && npm run simulate:merchant-moe-adversarial";

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
  const snapshots = [
    path.join(root, "web", "data", "latest-protocol-evidence.jsonl"),
    path.join(root, "data", "latest-protocol-evidence.jsonl"),
  ];
  const configured = process.env.TRACE_JSONL_PATH?.trim();
  if (configured) {
    return unique([
      ...(path.isAbsolute(configured) ? [configured] : [agentPath(root, configured), path.join(root, configured)]),
      ...snapshots,
    ]);
  }

  const traceDir = process.env.TRACE_DIR?.trim();
  if (traceDir) {
    const traceFile = path.join(traceDir, "agent-events.jsonl");
    return unique([
      ...(path.isAbsolute(traceFile) ? [traceFile] : [agentPath(root, traceFile), path.join(root, traceFile)]),
      ...snapshots,
    ]);
  }

  return [path.join(root, "agent", "traces", "agent-events.jsonl"), ...snapshots];
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

  return (
    firstParseError ?? {
      events: [...protocolEvidenceSnapshot] as unknown as TraceEvent[],
      path: path.join(workspaceRoot(), "web", "data", "latest-protocol-evidence.jsonl"),
      updatedAt: protocolEvidenceSnapshot[protocolEvidenceSnapshot.length - 1].ts,
    }
  );
}

function latestMerchantMoeEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === "merchant_moe.fork_simulation" ||
      event.type === "merchant_moe.fork_readiness" ||
      event.type === "merchant_moe.quote_smoke"
    ) {
      return event;
    }
  }
  return undefined;
}

function latestMerchantMoeAdversarialEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "merchant_moe.adversarial_suite") return events[index];
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

function forkSimulationStatus(report: MerchantMoeForkSimulationReport): ProtocolEvidenceStatus {
  if (report.simulationPassed && report.ok) return "ok";
  const findings = report.findings ?? [];
  return findings.some((finding) => finding.severity === "critical" || finding.severity === "blocker") ? "bad" : "warn";
}

function findingLabel(blocker: { ruleId?: string; severity?: string; reason?: string }): string {
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
  const report = (event.report ?? {}) as MerchantMoeForkReport;
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

function forkSimulationItem(root: string, artifact: TraceArtifact, event: TraceEvent): ProtocolEvidenceItem {
  const report = (event.report ?? {}) as MerchantMoeForkSimulationReport;
  const route = report.route ?? [];
  const risk = report.quoteRisk;
  const findings = report.findings ?? [];
  const status = forkSimulationStatus(report);
  const revertReason = report.simulation?.revertReason ?? report.simulation?.reason;
  const anvilBacked = report.fixtureKind === "anvil-mainnet-fork";

  return {
    id: "merchant-moe-evidence",
    name: "Merchant Moe",
    description: anvilBacked ? "Anvil-backed mainnet fork" : report.fixtureMode ? "Controlled fork fixture" : "Mainnet-fork simulation",
    status,
    label:
      anvilBacked && report.forkExecution?.passed
        ? "Vault fork pass"
        : anvilBacked && report.simulationPassed
          ? "Simulation only"
          : report.fixtureMode && report.simulationPassed
            ? "Fixture pass"
            : report.simulationPassed
              ? "Simulated"
              : report.simulationAttempted
                ? "Failed"
                : "Blocked",
    detail: `${routeLabel(route)}. Fork simulation ${
      report.simulationAttempted ? (report.simulationPassed ? "passed" : "failed") : "has not run"
    }; vault fork execution ${report.forkExecution?.passed ? "passed" : report.forkExecution?.attempted ? "failed" : "was not attempted"}; quote risk is ${risk?.status ?? "unchecked"}: ${risk?.reason ?? "no risk reason captured"}.`,
    command: anvilBacked ? anvilCommand : report.fixtureMode ? fixtureCommand : simulationCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    route,
    metrics: [
      { label: "Mode", value: text(report.simulationMode) },
      { label: "Evidence", value: anvilBacked ? "Anvil fork" : report.fixtureMode ? "fixture" : "fork" },
      { label: "Fork block", value: text(report.forkBlockNumber) },
      { label: "Setup txs", value: text(report.setupTransactionHashes?.length ?? 0) },
      { label: "Attempted", value: yesNo(report.simulationAttempted) },
      { label: "Passed", value: yesNo(report.simulationPassed) },
      { label: "Gas", value: text(report.simulation?.gasEstimate) },
      { label: "Calldata bytes", value: text(report.calldataBytes) },
      { label: "Fork RPC", value: yesNo(report.forkRpcConfigured) },
      { label: "Min out", value: text(report.minOutWei) },
      { label: "Slippage bps", value: text(report.slippageBps) },
      { label: "Vault", value: short(report.vaultEvidence?.address ?? report.vault) },
      {
        label: "Fork execution",
        value: report.forkExecution?.passed ? "passed" : report.forkExecution?.attempted ? "failed" : "not attempted",
      },
      { label: "Fork gas", value: text(report.forkExecution?.gasUsed) },
      { label: "Output delta", value: text(report.forkExecution?.tokenOutDelta) },
      { label: "Decision events", value: text(report.forkExecution?.agentDecisionEvents) },
    ],
    findings: [
      ...findings.slice(0, 5).map(findingLabel),
      ...(revertReason ? [`Revert: ${revertReason}`] : []),
    ],
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
  if (event.type === "merchant_moe.fork_simulation") return forkSimulationItem(root, artifact, event);
  if (event.type === "merchant_moe.fork_readiness") return forkReadinessItem(root, artifact, event);
  return quoteSmokeItem(root, artifact, event);
}

function missingAdversarialItem(root: string, artifact: TraceArtifact | MissingTraceArtifact): ProtocolEvidenceItem {
  return {
    id: "merchant-moe-adversarial",
    name: "Merchant Moe safety suite",
    description: "Real-fork adversarial controls",
    status: "warn",
    label: "Not captured",
    detail: "Run the adversarial Mantle-fork suite to prove unsafe paths stop before swap submission.",
    command: adversarialCommand,
    artifactPath: "path" in artifact && artifact.path ? displayPath(root, artifact.path) : undefined,
    updatedAt: "updatedAt" in artifact ? artifact.updatedAt : undefined,
    route: [],
    metrics: [],
    findings: [],
    nextSteps: ["Generate paused-vault, disallowed-router, stale-oracle, min-out, and unsafe-allowance evidence."],
  };
}

function adversarialItem(root: string, artifact: TraceArtifact | MissingTraceArtifact): ProtocolEvidenceItem {
  if (!("events" in artifact)) return missingAdversarialItem(root, artifact);
  const event = latestMerchantMoeAdversarialEvent(artifact.events);
  if (!event) return missingAdversarialItem(root, artifact);
  const report = (event.report ?? {}) as MerchantMoeAdversarialSuiteReport;
  const scenarios = report.scenarios ?? [];
  const allBlocked = Boolean(report.ok && report.noUnsafeSwapTransactionsSubmitted);

  return {
    id: "merchant-moe-adversarial",
    name: "Merchant Moe safety suite",
    description: "Real-fork adversarial controls",
    status: allBlocked ? "ok" : "bad",
    label: allBlocked ? `${report.passedScenarios ?? 0}/${report.totalScenarios ?? scenarios.length} blocked safely` : "Safety gap",
    detail: allBlocked
      ? "Paused vault, disallowed router, stale oracle, impossible minOut, and unsafe allowance all stopped before an unsafe swap transaction."
      : "At least one adversarial condition did not produce its expected blocker.",
    command: adversarialCommand,
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    route: report.route ?? [],
    metrics: [
      { label: "Fork block", value: text(report.forkBlockNumber) },
      { label: "Passed", value: `${report.passedScenarios ?? 0}/${report.totalScenarios ?? scenarios.length}` },
      { label: "Failed", value: text(report.failedScenarios ?? 0) },
      { label: "Unsafe swap txs", value: report.noUnsafeSwapTransactionsSubmitted ? "0" : "detected" },
      { label: "Amount in", value: text(report.amountIn) },
      { label: "Expected out", value: text(report.expectedOutWei) },
      { label: "Execution", value: report.executionEnabled ? "enabled" : "disabled" },
    ],
    findings: scenarios.map(
      (scenario) =>
        `${scenario.passed ? "PASS" : "FAIL"} ${scenario.label ?? scenario.id ?? "scenario"}: ${
          scenario.observedRuleId ?? "no blocker"
        } (${scenario.stage ?? "unknown"}${scenario.simulationAttempted ? ", simulated" : ", pre-simulation"})`,
    ),
    nextSteps: (report.nextSteps ?? []).slice(0, 4),
  };
}

export async function getProtocolEvidence(): Promise<ProtocolEvidence> {
  const root = workspaceRoot();
  const artifact = await readTraceArtifact(traceCandidates(root));
  return { items: [merchantMoeItem(root, artifact), adversarialItem(root, artifact)] };
}
