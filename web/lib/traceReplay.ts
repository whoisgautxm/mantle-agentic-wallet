import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import path from "path";
import type { DecisionLog } from "./events";
import { START_MNT_WEI, type BenchmarkStarts, type SeriesPoint } from "./pnl";

type Runner = "ai" | "baseline";

interface PortfolioSnapshot {
  mntBalanceWei?: string;
  tokenBalanceWei?: string;
  priceWei?: string;
  tokenValueWei?: string;
  portfolioValueWei?: string;
  referenceValueWei?: string;
}

interface TraceFinalAction {
  ts: string;
  type: "agent.final_action";
  tickId?: string;
  runner: Runner;
  outcome?: string;
  txHash?: string;
  decision?: {
    kind?: string;
    action?: string;
    target?: string;
    value?: string;
    valueWei?: string;
    rationale?: string;
  };
  portfolioBefore?: PortfolioSnapshot;
  portfolioAfter?: PortfolioSnapshot;
}

interface TraceLine {
  ts?: string;
  type?: string;
  runner?: string;
}

export interface TraceReplay {
  available: boolean;
  artifactPath?: string;
  updatedAt?: string;
  eventCount: number;
  finalActionCount: number;
  aiDecisions: DecisionLog[];
  baselineDecisions: DecisionLog[];
  series: SeriesPoint[];
  starts: BenchmarkStarts;
  error?: string;
}

const ONE = 10n ** 18n;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function rootPath(): string {
  return path.resolve(process.cwd(), "..");
}

function agentPath(root: string, value: string): string {
  return path.join(root, "agent", value);
}

function traceCandidates(root: string): string[] {
  const configured = process.env.TRACE_JSONL_PATH?.trim();
  const candidates = configured
    ? [
        ...(path.isAbsolute(configured)
          ? [configured]
          : [agentPath(root, configured), path.join(root, configured), path.join(process.cwd(), configured)]),
      ]
    : [];

  return unique([
    ...candidates,
    path.join(root, "agent", "traces", "agent-events.jsonl"),
    path.join(root, "agent", "traces", "agent-events-45min-openai-vs-human.jsonl"),
  ]);
}

function parseJsonLine(line: string): TraceLine | undefined {
  try {
    return JSON.parse(line) as TraceLine;
  } catch {
    return undefined;
  }
}

function isFinalAction(event: TraceLine | undefined): event is TraceFinalAction {
  return event?.type === "agent.final_action" && (event.runner === "ai" || event.runner === "baseline") && Boolean(event.ts);
}

function firstReference(events: TraceFinalAction[], runner: Runner): bigint {
  const match = events.find((event) => event.runner === runner);
  const reference =
    match?.portfolioAfter?.referenceValueWei ??
    match?.portfolioBefore?.referenceValueWei ??
    match?.portfolioAfter?.portfolioValueWei ??
    match?.portfolioBefore?.portfolioValueWei;
  return reference ? BigInt(reference) : START_MNT_WEI;
}

function timeLabel(ts: string): string {
  return ts.slice(11, 19);
}

function decisionValue(event: TraceFinalAction): string {
  return event.decision?.valueWei ?? event.decision?.value ?? "0";
}

function decisionAction(event: TraceFinalAction): string {
  return event.decision?.action ?? event.decision?.kind ?? event.outcome ?? "hold";
}

function toDecisionLog(event: TraceFinalAction, nonce: number): DecisionLog {
  return {
    nonce: nonce.toString(),
    target: event.decision?.target ?? "",
    value: decisionValue(event),
    rationale: event.decision?.rationale ?? `${decisionAction(event)} (${event.outcome ?? "final"})`,
    txHash: event.txHash ?? "",
    block: timeLabel(event.ts),
    timestamp: event.ts,
    outcome: event.outcome ?? decisionAction(event),
    source: "trace",
  };
}

function buildTraceSeries(events: TraceFinalAction[], starts: BenchmarkStarts): SeriesPoint[] {
  let aiPortfolioWei = starts.aiPortfolioWei;
  let baselinePortfolioWei = starts.baselinePortfolioWei;
  let aiTokenWei = 0n;
  let baselineTokenWei = 0n;
  let aiTokenValueWei = 0n;
  let baselineTokenValueWei = 0n;
  let priceWei = ONE;

  return events.flatMap((event) => {
    const portfolio = event.portfolioAfter;
    if (!portfolio?.portfolioValueWei) return [];

    if (portfolio.priceWei) priceWei = BigInt(portfolio.priceWei);
    const tokenWei = portfolio.tokenBalanceWei ? BigInt(portfolio.tokenBalanceWei) : 0n;
    const tokenValueWei = portfolio.tokenValueWei
      ? BigInt(portfolio.tokenValueWei)
      : (tokenWei * priceWei) / ONE;

    if (event.runner === "ai") {
      aiPortfolioWei = BigInt(portfolio.portfolioValueWei);
      aiTokenWei = tokenWei;
      aiTokenValueWei = tokenValueWei;
    } else {
      baselinePortfolioWei = BigInt(portfolio.portfolioValueWei);
      baselineTokenWei = tokenWei;
      baselineTokenValueWei = tokenValueWei;
    }

    return [
      {
        block: timeLabel(event.ts),
        priceWei: priceWei.toString(),
        aiTokenWei: aiTokenWei.toString(),
        baselineTokenWei: baselineTokenWei.toString(),
        aiTokenValueWei: aiTokenValueWei.toString(),
        baselineTokenValueWei: baselineTokenValueWei.toString(),
        aiPortfolioWei: aiPortfolioWei.toString(),
        baselinePortfolioWei: baselinePortfolioWei.toString(),
      },
    ];
  });
}

export async function getTraceReplay(): Promise<TraceReplay> {
  const root = rootPath();
  const artifactPath = traceCandidates(root).find((candidate) => existsSync(candidate));
  const empty: TraceReplay = {
    available: false,
    artifactPath,
    eventCount: 0,
    finalActionCount: 0,
    aiDecisions: [],
    baselineDecisions: [],
    series: [],
    starts: {
      aiPortfolioWei: START_MNT_WEI,
      baselinePortfolioWei: START_MNT_WEI,
    },
  };

  if (!artifactPath) return empty;

  try {
    const [raw, metadata] = await Promise.all([readFile(artifactPath, "utf8"), stat(artifactPath)]);
    const parsed = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseJsonLine);
    const finalActions = parsed.filter(isFinalAction).sort((a, b) => a.ts.localeCompare(b.ts));
    if (finalActions.length === 0) {
      return {
        ...empty,
        artifactPath,
        updatedAt: metadata.mtime.toISOString(),
        eventCount: parsed.length,
        error: "Trace exists but has no agent.final_action events yet.",
      };
    }

    const starts = {
      aiPortfolioWei: firstReference(finalActions, "ai"),
      baselinePortfolioWei: firstReference(finalActions, "baseline"),
    };
    const byRunner = (runner: Runner) => finalActions.filter((event) => event.runner === runner);
    const aiEvents = byRunner("ai");
    const baselineEvents = byRunner("baseline");

    const toLogs = (events: TraceFinalAction[]) => events.map((event, index) => toDecisionLog(event, index + 1)).reverse();

    return {
      available: true,
      artifactPath,
      updatedAt: metadata.mtime.toISOString(),
      eventCount: parsed.length,
      finalActionCount: finalActions.length,
      aiDecisions: toLogs(aiEvents),
      baselineDecisions: toLogs(baselineEvents),
      series: buildTraceSeries(finalActions, starts),
      starts,
    };
  } catch (error) {
    const e = error as Error;
    return {
      ...empty,
      artifactPath,
      error: e.message,
    };
  }
}
