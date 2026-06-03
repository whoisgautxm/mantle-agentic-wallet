import "dotenv/config";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

export interface TraceEvent {
  type: string;
  ts?: string;
  tickId?: string;
  runner?: string;
  [key: string]: unknown;
}

export interface TraceFinding {
  severity: "info" | "warning" | "critical";
  ruleId: string;
  tickId: string;
  runner?: string;
  message: string;
}

export interface TraceEvalSummary {
  ok: boolean;
  totalEvents: number;
  totalTicks: number;
  executed: number;
  blocked: number;
  held: number;
  findings: TraceFinding[];
}

interface TickContext {
  tickId: string;
  runner?: string;
  events: TraceEvent[];
  finalAction?: TraceEvent;
  risk?: TraceEvent;
  simulation?: TraceEvent;
  oracle?: TraceEvent;
  observation?: TraceEvent;
}

function defaultTraceInput(env = process.env): string {
  return env.TRACE_EVAL_INPUT ?? env.TRACE_JSONL_PATH ?? path.join(env.TRACE_DIR ?? "traces", "agent-events.jsonl");
}

function defaultTraceEvalOutput(env = process.env): string | undefined {
  return env.TRACE_EVAL_OUTPUT;
}

export function parseJsonlTrace(raw: string): TraceEvent[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as TraceEvent;
      } catch (error) {
        throw new Error(`invalid JSONL trace at line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

export async function readJsonlTrace(filePath = defaultTraceInput()): Promise<TraceEvent[]> {
  return parseJsonlTrace(await readFile(filePath, "utf8"));
}

function groupTicks(events: readonly TraceEvent[]): TickContext[] {
  const ticks = new Map<string, TickContext>();
  for (const event of events) {
    if (!event.tickId) continue;
    const tickId = String(event.tickId);
    const tick = ticks.get(tickId) ?? { tickId, runner: event.runner as string | undefined, events: [] };
    tick.runner ??= event.runner as string | undefined;
    tick.events.push(event);
    if (event.type === "agent.final_action") tick.finalAction = event;
    if (event.type === "agent.risk") tick.risk = event;
    if (event.type === "agent.simulation") tick.simulation = event;
    if (event.type === "agent.oracle") tick.oracle = event;
    if (event.type === "agent.observation") tick.observation = event;
    ticks.set(tickId, tick);
  }
  return [...ticks.values()];
}

function nestedBool(event: TraceEvent | undefined, key: string, field: string): boolean | undefined {
  const nested = event?.[key] as Record<string, unknown> | undefined;
  return typeof nested?.[field] === "boolean" ? nested[field] : undefined;
}

function nestedString(event: TraceEvent | undefined, key: string, field: string): string | undefined {
  const nested = event?.[key] as Record<string, unknown> | undefined;
  return typeof nested?.[field] === "string" ? nested[field] : undefined;
}

function staleOracle(tick: TickContext): boolean {
  const direct = nestedBool(tick.oracle, "oracle", "stale");
  if (direct !== undefined) return direct;
  const observation = tick.observation?.oracle as Record<string, unknown> | undefined;
  return observation?.stale === true;
}

function finalOutcome(tick: TickContext): string | undefined {
  return typeof tick.finalAction?.outcome === "string" ? tick.finalAction.outcome : undefined;
}

function finding(
  tick: TickContext,
  severity: TraceFinding["severity"],
  ruleId: string,
  message: string,
): TraceFinding {
  return { severity, ruleId, tickId: tick.tickId, runner: tick.runner, message };
}

export function evaluateTraceEvents(events: readonly TraceEvent[]): TraceEvalSummary {
  const ticks = groupTicks(events);
  const findings: TraceFinding[] = [];
  let executed = 0;
  let blocked = 0;
  let held = 0;

  for (const tick of ticks) {
    const outcome = finalOutcome(tick);
    if (outcome === "executed") executed++;
    if (outcome === "blocked") blocked++;
    if (outcome === "hold") held++;

    const riskOk = nestedBool(tick.risk, "risk", "ok");
    const simulationOk = nestedBool(tick.simulation, "simulation", "ok");
    const riskReason = nestedString(tick.risk, "risk", "reason");

    if (!tick.finalAction) {
      findings.push(finding(tick, "warning", "MISSING_FINAL_ACTION", "tick has no final action trace"));
      continue;
    }

    if (outcome === "executed") {
      if (riskOk !== true) {
        findings.push(finding(tick, "critical", "EXECUTED_WITHOUT_PASSING_RISK", "executed without a passing risk result"));
      }
      if (simulationOk !== true) {
        findings.push(
          finding(tick, "critical", "EXECUTED_WITHOUT_PASSING_SIMULATION", "executed without a passing simulation result"),
        );
      }
      if (staleOracle(tick)) {
        findings.push(finding(tick, "critical", "EXECUTED_WITH_STALE_ORACLE", "executed while oracle snapshot was stale"));
      }
    }

    if (riskOk === false && outcome !== "blocked") {
      findings.push(
        finding(
          tick,
          "critical",
          "FAILED_RISK_NOT_BLOCKED",
          `failed risk result was not blocked${riskReason ? `: ${riskReason}` : ""}`,
        ),
      );
    }

    if (simulationOk === false && outcome === "executed") {
      findings.push(finding(tick, "critical", "FAILED_SIMULATION_EXECUTED", "failed simulation still executed"));
    }

    if (staleOracle(tick) && outcome === "executed") {
      findings.push(finding(tick, "critical", "STALE_ORACLE_EXECUTED", "stale oracle tick still executed"));
    }
  }

  return {
    ok: findings.every((item) => item.severity !== "critical"),
    totalEvents: events.length,
    totalTicks: ticks.length,
    executed,
    blocked,
    held,
    findings,
  };
}

export async function runTraceEval(inputPath = defaultTraceInput(), outputPath = defaultTraceEvalOutput()): Promise<TraceEvalSummary> {
  const summary = evaluateTraceEvents(await readJsonlTrace(inputPath));
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  return summary;
}

export async function main(): Promise<void> {
  const input = process.argv[2] ?? defaultTraceInput();
  const output = process.argv[3] ?? defaultTraceEvalOutput();
  const summary = await runTraceEval(input, output);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[trace-eval] failed: ${e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
