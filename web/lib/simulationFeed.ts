import { readFile, stat } from "fs/promises";
import path from "path";

export type SimulationFeedStatus = "ok" | "warn" | "bad";

export interface SimulationFeedMetric {
  label: string;
  value: string;
}

export interface SimulationFeedItem {
  id: string;
  title: string;
  description: string;
  status: SimulationFeedStatus;
  label: string;
  runner?: string;
  protocolId?: string;
  updatedAt?: string;
  artifactPath?: string;
  command?: string;
  action: string;
  target: string;
  selector: string;
  valueWei: string;
  calldataBytes: string;
  simulationLabel: string;
  gasEstimate: string;
  revertReason: string;
  blockedReason: string;
  blockedRuleId?: string;
  txHash?: string;
  summary: string;
  metrics: SimulationFeedMetric[];
  findings: string[];
}

export interface SimulationFeed {
  items: SimulationFeedItem[];
  artifactPath?: string;
  updatedAt?: string;
  error?: string;
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
  tickId?: string;
  runner?: string;
  vault?: string;
  protocolId?: string;
  mode?: string;
  intent?: { action?: string; rationale?: string };
  quote?: { protocolId?: string };
  plan?: ExecutionPlan;
  decision?: ExecutionDecision | HoldDecision;
  simulation?: SimulationResult;
  risk?: RiskResult;
  limits?: unknown;
  outcome?: "hold" | "blocked" | "executed";
  reason?: string;
  ruleId?: string;
  txHash?: string;
  report?: MerchantMoeForkSimulationReport;
}

interface TickContext {
  tickId: string;
  events: TraceEvent[];
  started?: TraceEvent;
  quote?: TraceEvent;
  decision?: TraceEvent;
  simulation?: TraceEvent;
  risk?: TraceEvent;
  finalAction?: TraceEvent;
}

interface ExecutionPlan {
  protocolId?: string;
  action?: string;
  target?: string;
  valueWei?: string | number;
  calldata?: string;
  amountTokenWei?: string | number;
  expectedOutWei?: string | number;
  minOutWei?: string | number;
  slippageBps?: string | number;
  deadlineSeconds?: string | number;
  summary?: string;
}

interface ExecutionDecision {
  kind?: "execute";
  action?: string;
  target?: string;
  valueWei?: string | number;
  calldata?: string;
  amountTokenWei?: string | number;
  rationale?: string;
}

interface HoldDecision {
  kind?: "hold";
  rationale?: string;
}

interface SimulationResult {
  ok?: boolean;
  gasEstimate?: string | number;
  returnData?: string;
  reason?: string;
  revertReason?: string;
  warnings?: string[];
}

interface RiskResult {
  ok?: boolean;
  ruleId?: string;
  reason?: string;
  severity?: string;
}

interface MerchantMoeQuoteRisk {
  status?: "unchecked" | "ok" | "blocked";
  reason?: string;
  deviationBps?: string | number;
  maxDeviationBps?: string | number;
  referenceSource?: string;
}

interface MerchantMoeForkSimulationReport {
  ok?: boolean;
  protocolId?: string;
  mode?: string;
  fixtureMode?: boolean;
  fixtureKind?: "deterministic" | "anvil-mainnet-fork";
  forkBlockNumber?: string | number;
  setupTransactionHashes?: string[];
  simulationMode?: string;
  executionEnabled?: boolean;
  forkRpcConfigured?: boolean;
  forkSimulationEnabled?: boolean;
  simulationAttempted?: boolean;
  simulationPassed?: boolean;
  target?: string;
  router?: string;
  from?: string;
  vault?: string;
  valueWei?: string | number;
  calldataSelector?: string;
  calldataBytes?: string | number;
  route?: string[];
  amountIn?: string | number;
  expectedOutWei?: string | number;
  minOutWei?: string | number;
  slippageBps?: string | number;
  quoteRisk?: MerchantMoeQuoteRisk;
  simulation?: SimulationResult;
  findings?: Array<{
    ruleId?: string;
    severity?: string;
    reason?: string;
  }>;
  nextSteps?: string[];
}

const simulationCommand = "cd agent && npm run simulate:merchant-moe-fork";
const fixtureCommand = "cd agent && npm run simulate:merchant-moe-fixture";
const anvilCommand = "cd agent && npm run simulate:merchant-moe-anvil";
const agentCommand = "cd agent && npm run demo";

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

function text(value: unknown, fallback = "n/a"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function yesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function byteLength(calldata: unknown): string {
  if (typeof calldata !== "string" || !calldata.startsWith("0x")) return "0";
  return Math.max(0, Math.floor((calldata.length - 2) / 2)).toString();
}

function selector(calldata: unknown): string {
  if (typeof calldata !== "string" || !calldata.startsWith("0x") || calldata.length < 10) return "not built";
  return calldata.slice(0, 10);
}

function short(address: string | undefined): string {
  if (!address) return "n/a";
  if (address.length < 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function statusFromTick(finalAction: TraceEvent | undefined, risk: RiskResult | undefined, simulation: SimulationResult | undefined): SimulationFeedStatus {
  const riskBlocked = risk?.ok === false;
  const simulationFailed = simulation?.ok === false;
  if (finalAction?.outcome === "blocked" || riskBlocked || simulationFailed) return "bad";
  if (finalAction?.outcome === "executed" || (simulation?.ok === true && !riskBlocked)) return "ok";
  return "warn";
}

function labelFromTick(finalAction: TraceEvent | undefined, risk: RiskResult | undefined, simulation: SimulationResult | undefined): string {
  if (finalAction?.outcome === "executed") return "Executed";
  if (finalAction?.outcome === "blocked" || risk?.ok === false) return "Blocked";
  if (simulation?.ok === false) return "Sim failed";
  if (simulation?.ok === true) return "Sim passed";
  if (finalAction?.outcome === "hold") return "Held";
  return "Pending";
}

function simulationLabel(simulation: SimulationResult | undefined): string {
  if (!simulation) return "not run";
  return simulation.ok ? "pass" : "fail";
}

function blockedReason(
  finalAction: TraceEvent | undefined,
  risk: RiskResult | undefined,
  simulation: SimulationResult | undefined,
): string {
  if (finalAction?.outcome === "blocked") return text(finalAction.reason);
  if (risk?.ok === false) return text(risk.reason);
  if (simulation?.ok === false) return text(simulation.revertReason ?? simulation.reason);
  if (finalAction?.outcome === "hold" && finalAction.reason) return finalAction.reason;
  return "none";
}

function riskRule(finalAction: TraceEvent | undefined, risk: RiskResult | undefined): string | undefined {
  return finalAction?.ruleId ?? risk?.ruleId;
}

function newestTs(events: readonly TraceEvent[], fallback: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ts = events[index]?.ts;
    if (ts) return ts;
  }
  return fallback;
}

function groupTicks(events: readonly TraceEvent[]): TickContext[] {
  const groups = new Map<string, TickContext>();

  for (const event of events) {
    if (!event.tickId || !event.type?.startsWith("agent.")) continue;
    const tick = groups.get(event.tickId) ?? { tickId: event.tickId, events: [] };
    tick.events.push(event);

    if (event.type === "agent.tick.started") tick.started = event;
    if (event.type === "agent.quote") tick.quote = event;
    if (event.type === "agent.decision") tick.decision = event;
    if (event.type === "agent.simulation") tick.simulation = event;
    if (event.type === "agent.risk") tick.risk = event;
    if (event.type === "agent.final_action") tick.finalAction = event;

    groups.set(event.tickId, tick);
  }

  return [...groups.values()];
}

function tickHasPreflight(tick: TickContext): boolean {
  const decision = (tick.decision?.decision ?? tick.finalAction?.decision) as ExecutionDecision | HoldDecision | undefined;
  return Boolean(tick.decision?.plan || tick.simulation || tick.risk || tick.finalAction?.outcome === "blocked" || decision?.kind === "execute");
}

function itemFromTick(root: string, artifact: TraceArtifact, tick: TickContext): SimulationFeedItem | undefined {
  if (!tickHasPreflight(tick)) return undefined;

  const decision = (tick.decision?.decision ?? tick.finalAction?.decision) as ExecutionDecision | HoldDecision | undefined;
  const plan = tick.decision?.plan;
  const simulation = tick.simulation?.simulation;
  const risk = tick.risk?.risk;
  const finalAction = tick.finalAction;
  const executable = decision?.kind === "execute" ? decision : undefined;
  const calldata = executable?.calldata ?? plan?.calldata;
  const action = plan?.action ?? executable?.action ?? decision?.kind ?? tick.decision?.intent?.action ?? "unknown";
  const target = executable?.target ?? plan?.target;
  const valueWei = executable?.valueWei ?? plan?.valueWei;
  const status = statusFromTick(finalAction, risk, simulation);
  const updatedAt = newestTs(tick.events, artifact.updatedAt);

  return {
    id: `tick-${tick.tickId}`,
    title: `${text(tick.started?.runner ?? tick.decision?.runner ?? finalAction?.runner, "agent")} vault preflight`,
    description: `tick ${tick.tickId.slice(0, 8)}`,
    status,
    label: labelFromTick(finalAction, risk, simulation),
    runner: optionalText(tick.started?.runner ?? tick.decision?.runner ?? finalAction?.runner),
    protocolId: optionalText(tick.started?.protocolId ?? tick.quote?.protocolId ?? tick.quote?.quote?.protocolId ?? plan?.protocolId),
    updatedAt,
    artifactPath: displayPath(root, artifact.path),
    command: agentCommand,
    action,
    target: short(target),
    selector: selector(calldata),
    valueWei: text(valueWei),
    calldataBytes: byteLength(calldata),
    simulationLabel: simulationLabel(simulation),
    gasEstimate: text(simulation?.gasEstimate),
    revertReason: text(simulation?.revertReason ?? simulation?.reason, "none"),
    blockedReason: blockedReason(finalAction, risk, simulation),
    blockedRuleId: riskRule(finalAction, risk),
    txHash: finalAction?.txHash,
    summary: text(plan?.summary ?? executable?.rationale ?? (decision as HoldDecision | undefined)?.rationale ?? finalAction?.reason, "no rationale captured"),
    metrics: [
      { label: "Simulation", value: simulationLabel(simulation) },
      { label: "Gas estimate", value: text(simulation?.gasEstimate) },
      { label: "Calldata bytes", value: byteLength(calldata) },
      { label: "Value wei", value: text(valueWei) },
      { label: "Expected out", value: text(plan?.expectedOutWei) },
      { label: "Min out", value: text(plan?.minOutWei) },
    ],
    findings: [
      ...(risk?.ok === false ? [`${risk.ruleId ?? "RISK_BLOCK"}: ${risk.reason ?? "risk rejected execution"}`] : []),
      ...(simulation?.ok === false ? [`Revert: ${simulation.revertReason ?? simulation.reason ?? "simulation failed"}`] : []),
      ...(simulation?.warnings ?? []),
    ].slice(0, 5),
  };
}

function merchantMoeStatus(report: MerchantMoeForkSimulationReport): SimulationFeedStatus {
  if (report.simulationPassed && report.ok) return "ok";
  if ((report.findings ?? []).some((finding) => finding.severity === "blocker" || finding.severity === "critical")) return "bad";
  if (report.simulation?.ok === false) return "bad";
  return "warn";
}

function merchantMoeLabel(report: MerchantMoeForkSimulationReport): string {
  if (report.simulationPassed) return "Sim passed";
  if (report.simulationAttempted) return "Sim failed";
  return "Blocked before sim";
}

function primaryBlocker(
  report: MerchantMoeForkSimulationReport,
): { ruleId?: string; reason: string } {
  const finding =
    (report.findings ?? []).find((entry) => entry.severity === "blocker" || entry.severity === "critical") ??
    (report.findings ?? [])[0];
  if (finding) return { ruleId: finding.ruleId, reason: text(finding.reason, "review simulation report") };
  if (!report.executionEnabled) {
    return {
      ruleId: "LIVE_EXECUTION_DISABLED",
      reason: "Live execution is disabled for this protocol path.",
    };
  }
  return { reason: "none" };
}

function routeLabel(route: readonly string[] | undefined): string {
  if (!route?.length) return "route not captured";
  return route.map(short).join(" -> ");
}

function itemFromMerchantMoeForkSimulation(root: string, artifact: TraceArtifact, event: TraceEvent): SimulationFeedItem | undefined {
  if (event.type !== "merchant_moe.fork_simulation") return undefined;
  const report = event.report ?? {};
  const blocker = primaryBlocker(report);
  const simulation = report.simulation;
  const anvilBacked = report.fixtureKind === "anvil-mainnet-fork";

  return {
    id: `merchant-moe-fork-${event.ts ?? artifact.updatedAt}`,
    title: anvilBacked ? "Merchant Moe Anvil preflight" : report.fixtureMode ? "Merchant Moe fixture preflight" : "Merchant Moe fork preflight",
    description: anvilBacked ? "real mainnet-fork contracts" : report.fixtureMode ? "controlled fixture" : text(report.simulationMode, "mainnet-fork simulation"),
    status: merchantMoeStatus(report),
    label: merchantMoeLabel(report),
    runner: "read-only adapter",
    protocolId: report.protocolId ?? event.protocolId ?? "merchant-moe",
    updatedAt: event.ts ?? artifact.updatedAt,
    artifactPath: displayPath(root, artifact.path),
    command: anvilBacked ? anvilCommand : report.fixtureMode ? fixtureCommand : simulationCommand,
    action: "swap",
    target: short(report.target ?? report.router),
    selector: text(report.calldataSelector, "not built"),
    valueWei: text(report.valueWei),
    calldataBytes: text(report.calldataBytes, "0"),
    simulationLabel: report.simulationAttempted ? simulationLabel(simulation) : "blocked",
    gasEstimate: text(simulation?.gasEstimate),
    revertReason: text(simulation?.revertReason ?? simulation?.reason, "none"),
    blockedReason: blocker.reason,
    blockedRuleId: blocker.ruleId,
    summary: `${routeLabel(report.route)}. Quote risk: ${report.quoteRisk?.status ?? "unchecked"} - ${
      report.quoteRisk?.reason ?? "no quote-risk reason captured"
    }.`,
    metrics: [
      { label: "Simulation", value: report.simulationAttempted ? simulationLabel(simulation) : "blocked" },
      { label: "Evidence mode", value: anvilBacked ? "Anvil fork" : report.fixtureMode ? "fixture" : "fork" },
      { label: "Fork block", value: text(report.forkBlockNumber) },
      { label: "Setup txs", value: text(report.setupTransactionHashes?.length ?? 0) },
      { label: "Gas estimate", value: text(simulation?.gasEstimate) },
      { label: "Calldata bytes", value: text(report.calldataBytes, "0") },
      { label: "Value wei", value: text(report.valueWei) },
      { label: "Min out", value: text(report.minOutWei) },
      { label: "Deviation bps", value: text(report.quoteRisk?.deviationBps, report.quoteRisk?.status === "unchecked" ? "unchecked" : "n/a") },
    ],
    findings: [
      ...(report.findings ?? []).map((finding) => `${finding.ruleId ?? "FINDING"}: ${finding.reason ?? "review report"}`),
      ...(simulation?.revertReason || simulation?.reason ? [`Revert: ${simulation.revertReason ?? simulation.reason}`] : []),
    ].slice(0, 5),
  };
}

function buildItems(root: string, artifact: TraceArtifact): SimulationFeedItem[] {
  const tickItems = groupTicks(artifact.events)
    .map((tick) => itemFromTick(root, artifact, tick))
    .filter((item): item is SimulationFeedItem => Boolean(item));
  const merchantItems = artifact.events
    .map((event) => itemFromMerchantMoeForkSimulation(root, artifact, event))
    .filter((item): item is SimulationFeedItem => Boolean(item));

  return [...tickItems, ...merchantItems].sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });
}

export async function getSimulationFeed(limit = 5): Promise<SimulationFeed> {
  const root = workspaceRoot();
  const artifact = await readTraceArtifact(traceCandidates(root));
  if (!("events" in artifact)) {
    return {
      items: [],
      artifactPath: artifact.path ? displayPath(root, artifact.path) : undefined,
      error: artifact.error,
    };
  }

  return {
    items: buildItems(root, artifact).slice(0, limit),
    artifactPath: displayPath(root, artifact.path),
    updatedAt: artifact.updatedAt,
  };
}
