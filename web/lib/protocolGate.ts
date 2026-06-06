import { readFile, stat } from "fs/promises";
import path from "path";

export type ProtocolGateStatus = "ok" | "warn" | "bad";

export interface ProtocolGateMetric {
  label: string;
  value: string;
}

export interface ProtocolGateStep {
  id: string;
  name: string;
  description: string;
  status: ProtocolGateStatus;
  label: string;
  detail: string;
}

export interface ProtocolGate {
  protocolId: "merchant-moe";
  title: string;
  status: ProtocolGateStatus;
  label: string;
  headline: string;
  detail: string;
  route: string;
  artifactPath?: string;
  updatedAt?: string;
  command: string;
  metrics: ProtocolGateMetric[];
  steps: ProtocolGateStep[];
  blockers: string[];
  nextSteps: string[];
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
  report?: MerchantMoeForkSimulationReport | MerchantMoeForkReadinessReport;
  quote?: MerchantMoeQuote;
  risk?: MerchantMoeQuoteRisk;
  executionEnabled?: boolean;
}

interface MerchantMoeQuote {
  route?: string[];
  amountIn?: string | number;
  amountOut?: string | number;
}

interface MerchantMoeQuoteRisk {
  status?: "unchecked" | "ok" | "blocked";
  reason?: string;
  deviationBps?: string | number;
  maxDeviationBps?: string | number;
  referenceSource?: string;
}

interface MerchantMoeForkReadinessReport {
  ok?: boolean;
  executionEnabled?: boolean;
  forkRpcConfigured?: boolean;
  forkSimulationEnabled?: boolean;
  route?: string[];
  amountIn?: string | number;
  expectedOutWei?: string | number;
  minOutWei?: string | number;
  slippageBps?: string | number;
  quoteRisk?: MerchantMoeQuoteRisk;
  blockers?: Finding[];
  nextSteps?: string[];
}

interface MerchantMoeForkSimulationReport extends MerchantMoeForkReadinessReport {
  fixtureMode?: boolean;
  simulationMode?: string;
  simulationAttempted?: boolean;
  simulationPassed?: boolean;
  calldataSource?: "env" | "auto" | "missing" | "build-error";
  calldataBytes?: string | number;
  target?: string;
  router?: string;
  from?: string;
  vault?: string;
  valueWei?: string | number;
  preflight?: {
    status?: "unchecked" | "ok" | "blocked";
    tokenIn?: string;
    owner?: string;
    spender?: string;
    requiredAmountIn?: string | number;
    balanceRaw?: string | number;
    allowanceRaw?: string | number;
    allowanceStatus?: string;
    balanceOk?: boolean;
    allowanceOk?: boolean;
    reason?: string;
    warnings?: string[];
  };
  simulation?: {
    ok?: boolean;
    gasEstimate?: string | number;
    reason?: string;
    revertReason?: string;
  };
  findings?: Finding[];
}

interface Finding {
  ruleId?: string;
  severity?: string;
  reason?: string;
}

const forkCommand = "cd agent && npm run simulate:merchant-moe-fork";
const fixtureCommand = "cd agent && npm run simulate:merchant-moe-fixture";

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
      return { events, path: filePath, updatedAt: info.mtime.toISOString() };
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") continue;
      firstParseError ??= { path: filePath, error: e.message };
    }
  }

  return firstParseError ?? {};
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

function routeLabel(route: readonly string[] | undefined): string {
  if (!route?.length) return "Route not captured";
  return route.map(short).join(" -> ");
}

function findingText(finding: Finding): string {
  return `${finding.ruleId ?? "FINDING"}: ${finding.reason ?? "review report"}`;
}

function hasFinding(report: MerchantMoeForkSimulationReport, ruleId: string): boolean {
  return (report.findings ?? []).some((finding) => finding.ruleId === ruleId);
}

function step(
  id: string,
  name: string,
  description: string,
  status: ProtocolGateStatus,
  label: string,
  detail: string,
): ProtocolGateStep {
  return { id, name, description, status, label, detail };
}

function quoteStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const risk = report.quoteRisk;
  const status: ProtocolGateStatus = risk?.status === "blocked" ? "bad" : report.expectedOutWei || report.amountIn ? "ok" : "warn";
  return step(
    "quote",
    "Real DEX quote",
    "Read Merchant Moe LBQuoter for the configured WMNT/stable route.",
    status,
    status === "ok" ? "Captured" : status === "bad" ? "Rejected" : "Missing",
    `amountIn ${text(report.amountIn)} -> expectedOut ${text(report.expectedOutWei)}.`,
  );
}

function oracleStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const risk = report.quoteRisk;
  const status: ProtocolGateStatus = risk?.status === "ok" ? "ok" : risk?.status === "blocked" ? "bad" : "warn";
  return step(
    "oracle",
    "Oracle/reference check",
    "Compare DEX quote against Pyth or configured reference pricing.",
    status,
    risk?.status === "ok" ? "Within threshold" : risk?.status === "blocked" ? "Deviation blocked" : "Unchecked",
    risk?.reason ?? "No quote/reference deviation evidence captured yet.",
  );
}

function calldataStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const source = report.calldataSource;
  const bytes = Number(report.calldataBytes ?? 0);
  const buildFailed = hasFinding(report, "CALLDATA_BUILD_FAILED");
  const missing = hasFinding(report, "CALLDATA_MISSING") || source === "missing";
  const status: ProtocolGateStatus = buildFailed || missing ? "bad" : bytes > 4 ? "ok" : "warn";
  return step(
    "calldata",
    "Router calldata",
    "Build LBRouter swap calldata in code, never from model-authored bytes.",
    status,
    status === "ok" ? text(source, "built") : buildFailed ? "Build failed" : "Not built",
    `${text(source, "unknown")} source, ${text(report.calldataBytes, "0")} bytes.`,
  );
}

function balanceStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const preflight = report.preflight;
  const status: ProtocolGateStatus =
    preflight?.balanceOk === true ? "ok" : preflight?.balanceOk === false || hasFinding(report, "TOKEN_BALANCE_TOO_LOW") ? "bad" : "warn";
  return step(
    "balance",
    "Token-in balance",
    "Read ERC20 balanceOf for the account or vault that would own the swap tokens.",
    status,
    status === "ok" ? "Enough" : status === "bad" ? "Too low" : "Not checked",
    `owner ${short(preflight?.owner)}, balance ${text(preflight?.balanceRaw)}, required ${text(preflight?.requiredAmountIn ?? report.amountIn)}.`,
  );
}

function allowanceStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const preflight = report.preflight;
  const unsafe = hasFinding(report, "ROUTER_ALLOWANCE_UNSAFE");
  const tooLow = preflight?.allowanceOk === false || hasFinding(report, "ROUTER_ALLOWANCE_TOO_LOW");
  const status: ProtocolGateStatus = tooLow ? "bad" : unsafe ? "warn" : preflight?.allowanceOk === true ? "ok" : "warn";
  return step(
    "allowance",
    "Router allowance",
    "Read token allowance from the owner to Merchant Moe LBRouter.",
    status,
    tooLow ? "Too low" : unsafe ? "Unsafe size" : preflight?.allowanceOk ? "Enough" : "Not checked",
    `allowance ${text(preflight?.allowanceRaw)}, status ${text(preflight?.allowanceStatus)}, spender ${short(preflight?.spender ?? report.router)}.`,
  );
}

function simulationStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  const status: ProtocolGateStatus = report.simulationPassed ? "ok" : report.simulationAttempted ? "bad" : "warn";
  const reason = report.simulation?.revertReason ?? report.simulation?.reason;
  return step(
    "simulation",
    "Fork simulation",
    "Call the router or fork-local vault on a Mantle mainnet fork before any live transaction.",
    status,
    report.simulationPassed ? "Passed" : report.simulationAttempted ? "Failed" : "Waiting",
    reason ?? `attempted ${yesNo(report.simulationAttempted)}, gas ${text(report.simulation?.gasEstimate)}.`,
  );
}

function executionStep(report: MerchantMoeForkSimulationReport): ProtocolGateStep {
  if (report.fixtureMode && report.ok && report.simulationPassed && report.executionEnabled === false) {
    return step(
      "execution",
      "Live execution",
      "Final live-trading switch stays disabled until every upstream gate passes.",
      "ok",
      "Safely disabled",
      "Controlled fixture passed while live Merchant Moe execution stayed disabled.",
    );
  }

  const ready = report.ok && report.simulationPassed && report.executionEnabled === true;
  return step(
    "execution",
    "Live execution",
    "Final live-trading switch stays disabled until every upstream gate passes.",
    ready ? "ok" : "warn",
    report.executionEnabled ? "Enabled" : "Disabled",
    report.executionEnabled
      ? "Execution is enabled; verify deployment policy before use."
      : "Live Merchant Moe swaps remain intentionally disabled.",
  );
}

function statusFromSteps(steps: readonly ProtocolGateStep[]): ProtocolGateStatus {
  if (steps.some((entry) => entry.status === "bad")) return "bad";
  if (steps.some((entry) => entry.status === "warn")) return "warn";
  return "ok";
}

function labelFromStatus(status: ProtocolGateStatus): string {
  if (status === "ok") return "Ready";
  if (status === "bad") return "Blocked";
  return "Watching";
}

function latestMerchantEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
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

function fallbackGate(root: string, artifact: MissingTraceArtifact | TraceArtifact, error?: string): ProtocolGate {
  return {
    protocolId: "merchant-moe",
    title: "Merchant Moe real-protocol gate",
    status: error ? "bad" : "warn",
    label: error ? "Trace invalid" : "No trace",
    headline: error ? "Trace artifact could not be parsed" : "Run a Merchant Moe smoke to populate the real protocol gate",
    detail: error ?? "The dashboard has not seen Merchant Moe quote/readiness/simulation evidence yet.",
    route: "Route not captured",
    artifactPath: "path" in artifact && artifact.path ? displayPath(root, artifact.path) : undefined,
    updatedAt: "updatedAt" in artifact ? artifact.updatedAt : undefined,
    command: fixtureCommand,
    metrics: [],
    steps: [
      step("quote", "Real DEX quote", "Read Merchant Moe LBQuoter.", "warn", "Missing", "No quote event captured."),
      step("oracle", "Oracle/reference check", "Compare quote against Pyth/reference pricing.", "warn", "Missing", "No risk event captured."),
      step("calldata", "Router calldata", "Build router calldata in code.", "warn", "Missing", "No fork simulation event captured."),
      step("balance", "Token-in balance", "Check ERC20 balance before simulation.", "warn", "Missing", "No ERC20 preflight captured."),
      step("allowance", "Router allowance", "Check router allowance before simulation.", "warn", "Missing", "No ERC20 preflight captured."),
      step("simulation", "Fork simulation", "Simulate on a mainnet fork.", "warn", "Missing", "No simulation captured."),
      step("execution", "Live execution", "Keep live swaps disabled until all gates pass.", "warn", "Disabled", "Live swaps disabled."),
    ],
    blockers: error ? [error] : [],
    nextSteps: ["Run cd agent && npm run simulate:merchant-moe-fixture or cd agent && npm run simulate:merchant-moe-fork."],
  };
}

function gateFromEvent(root: string, artifact: TraceArtifact, event: TraceEvent): ProtocolGate {
  const report = (event.report ?? {}) as MerchantMoeForkSimulationReport;
  const quote = event.quote ?? {};
  const risk = event.risk ?? report.quoteRisk;
  const normalizedReport: MerchantMoeForkSimulationReport = {
    ...report,
    route: report.route ?? quote.route,
    amountIn: report.amountIn ?? quote.amountIn,
    expectedOutWei: report.expectedOutWei ?? quote.amountOut,
    quoteRisk: risk,
    findings: report.findings ?? report.blockers,
  };
  const steps = [
    quoteStep(normalizedReport),
    oracleStep(normalizedReport),
    calldataStep(normalizedReport),
    balanceStep(normalizedReport),
    allowanceStep(normalizedReport),
    simulationStep(normalizedReport),
    executionStep(normalizedReport),
  ];
  const status = statusFromSteps(steps);
  const blockers = (normalizedReport.findings ?? [])
    .filter((finding) => finding.severity === "blocker" || finding.severity === "critical")
    .map(findingText);
  const firstBad = steps.find((entry) => entry.status === "bad");

  const command = normalizedReport.fixtureMode ? fixtureCommand : forkCommand;

  return {
    protocolId: "merchant-moe",
    title: "Merchant Moe real-protocol gate",
    status,
    label: normalizedReport.fixtureMode && status === "ok" ? "Fixture pass" : labelFromStatus(status),
    headline: firstBad
      ? `Blocked at ${firstBad.name}`
      : normalizedReport.fixtureMode && status === "ok"
        ? "Controlled Merchant Moe fixture passed every upstream gate"
        : status === "ok"
          ? "All protocol gates are green"
          : "Protocol path is partially configured",
    detail:
      firstBad?.detail ??
      (normalizedReport.fixtureMode
        ? "This is a deterministic fixture proving quote, oracle, calldata, ERC20 state, and simulation plumbing without live funds."
        : "Merchant Moe evidence is available, but at least one gate is still intentionally cautious before live execution."),
    route: routeLabel(normalizedReport.route),
    artifactPath: displayPath(root, artifact.path),
    updatedAt: event.ts ?? artifact.updatedAt,
    command,
    metrics: [
      { label: "Quote risk", value: text(normalizedReport.quoteRisk?.status, "unchecked") },
      { label: "Calldata", value: text(normalizedReport.calldataSource, "n/a") },
      { label: "Balance", value: text(normalizedReport.preflight?.balanceRaw) },
      { label: "Allowance", value: text(normalizedReport.preflight?.allowanceRaw) },
      { label: "Simulation", value: normalizedReport.simulationAttempted ? (normalizedReport.simulationPassed ? "passed" : "failed") : "not attempted" },
      { label: "Live execution", value: normalizedReport.executionEnabled ? "enabled" : "disabled" },
      { label: "Evidence mode", value: normalizedReport.fixtureMode ? "fixture" : "fork" },
    ],
    steps,
    blockers: blockers.slice(0, 5),
    nextSteps: (normalizedReport.nextSteps ?? []).slice(0, 5),
  };
}

export async function getProtocolGate(): Promise<ProtocolGate> {
  const root = workspaceRoot();
  const artifact = await readTraceArtifact(traceCandidates(root));
  if (!("events" in artifact)) return fallbackGate(root, artifact, artifact.error);

  const event = latestMerchantEvent(artifact.events);
  if (!event) return fallbackGate(root, artifact);
  return gateFromEvent(root, artifact, event);
}
