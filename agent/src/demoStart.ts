import { spawn, type ChildProcess } from "child_process";
import { createConnection } from "net";
import { rm, stat } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { config as loadDotenv } from "dotenv";
import {
  cleanStaleProcessRecords,
  isPidRunning,
  readProcessRecord,
  removeProcessRecord,
  sleep,
  terminateProcessRecord,
  writeProcessRecord,
  type DemoComponent,
  type DemoProcessRecord,
} from "./runtime/demoRuntime.js";

interface DemoOptions {
  keeper: boolean;
  agent: boolean;
  baseline: boolean;
  dashboard: boolean;
  prodDashboard: boolean;
  scenarioEval: boolean;
  traceEvalOnStop: boolean;
  freshTrace: boolean;
  port: number;
}

interface ComponentSpec {
  component: Exclude<DemoComponent, "orchestrator">;
  cwd: string;
  command: string[];
  port?: number;
}

interface RunningComponent {
  record: DemoProcessRecord;
  child: ChildProcess;
}

const repoRoot = path.resolve(process.cwd(), "..");
const agentDir = path.join(repoRoot, "agent");
const webDir = path.join(repoRoot, "web");
const traceInput = path.join("traces", "agent-events.jsonl");
const traceSummary = path.join("traces", "trace-summary.json");
const scenarioSummary = path.join("traces", "scenario-summary.json");

export function parseDemoArgs(argv: readonly string[], env = process.env): DemoOptions {
  const options: DemoOptions = {
    keeper: true,
    agent: true,
    baseline: true,
    dashboard: true,
    prodDashboard: false,
    scenarioEval: env.DEMO_RUN_SCENARIO_EVAL !== "false",
    traceEvalOnStop: env.DEMO_RUN_TRACE_EVAL_ON_STOP !== "false",
    freshTrace: false,
    port: Number(env.DEMO_DASHBOARD_PORT ?? "3000"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--no-keeper") options.keeper = false;
    else if (arg === "--no-agent") options.agent = false;
    else if (arg === "--no-baseline") options.baseline = false;
    else if (arg === "--no-dashboard") options.dashboard = false;
    else if (arg === "--prod-dashboard") options.prodDashboard = true;
    else if (arg === "--skip-scenario-eval") options.scenarioEval = false;
    else if (arg === "--no-trace-eval") options.traceEvalOnStop = false;
    else if (arg === "--fresh-trace") options.freshTrace = true;
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else throw new Error(`unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error(`invalid dashboard port: ${options.port}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run demo -- [options]

Starts the full local demo loop and stops child processes on Ctrl-C.

Options:
  --no-keeper            Do not start MockDEX price keeper
  --no-agent             Do not start AI runner
  --no-baseline          Do not start DCA baseline runner
  --no-dashboard         Do not start Next.js dashboard
  --prod-dashboard       Use npm run start for web instead of npm run dev
  --port <port>          Dashboard port (default: DEMO_DASHBOARD_PORT or 3000)
  --skip-scenario-eval   Do not generate traces/scenario-summary.json on start
  --no-trace-eval        Do not generate traces/trace-summary.json on shutdown
  --fresh-trace          Remove traces/agent-events.jsonl before starting
`);
}

function loadEnv(): NodeJS.ProcessEnv {
  loadDotenv({ path: path.join(repoRoot, ".env") });
  loadDotenv({ path: path.join(agentDir, ".env") });
  return {
    ...process.env,
    TRACE_ENABLED: process.env.TRACE_ENABLED ?? "true",
    TRACE_JSONL_PATH: process.env.TRACE_JSONL_PATH ?? traceInput,
    TRACE_EVAL_OUTPUT: process.env.TRACE_EVAL_OUTPUT ?? traceSummary,
    SCENARIO_EVAL_OUTPUT: process.env.SCENARIO_EVAL_OUTPUT ?? scenarioSummary,
  };
}

function missingRequiredEnv(options: DemoOptions, env: NodeJS.ProcessEnv): string[] {
  const required = new Set<string>();
  if (options.keeper || options.agent || options.baseline) required.add("MANTLE_RPC_URL");
  if (options.keeper) required.add("OWNER_PRIVATE_KEY");
  if (options.agent) {
    required.add("AGENT_PRIVATE_KEY");
    const provider = (env.AI_PROVIDER ?? "openai").toLowerCase();
    required.add(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  }
  if (options.baseline) required.add("BASELINE_PRIVATE_KEY");
  return [...required].filter((name) => !env[name]?.trim());
}

function selectedSpecs(options: DemoOptions): ComponentSpec[] {
  const specs: ComponentSpec[] = [];
  if (options.keeper) specs.push({ component: "keeper", cwd: agentDir, command: ["npm", "run", "keeper"] });
  if (options.agent) specs.push({ component: "agent", cwd: agentDir, command: ["npm", "start"] });
  if (options.baseline) specs.push({ component: "baseline", cwd: agentDir, command: ["npm", "run", "baseline"] });
  if (options.dashboard) {
    specs.push({
      component: "web",
      cwd: webDir,
      command: ["npm", "run", options.prodDashboard ? "start" : "dev", "--", "--port", options.port.toString()],
      port: options.port,
    });
  }
  return specs;
}

function prefixLogs(component: DemoComponent, stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream): void {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) sink.write(`[${component}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) sink.write(`[${component}] ${buffer}\n`);
  });
}

async function runOneShot(label: string, command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    prefixLogs(label as DemoComponent, child.stdout, process.stdout);
    prefixLogs(label as DemoComponent, child.stderr, process.stderr);
    child.on("error", (error) => {
      console.error(`[${label}] failed to start: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function maybeRunScenarioEval(options: DemoOptions, env: NodeJS.ProcessEnv): Promise<void> {
  if (!options.scenarioEval) return;
  console.log("[demo] generating scenario eval summary");
  const code = await runOneShot(
    "scenario-eval",
    ["npm", "run", "eval:scenarios", "--", "evals/scenarios", scenarioSummary],
    agentDir,
    env,
  );
  if (code !== 0) console.warn(`[demo] scenario eval exited with code ${code}; dashboard will show the last artifact if present`);
}

async function maybeRunTraceEval(options: DemoOptions, env: NodeJS.ProcessEnv): Promise<void> {
  if (!options.traceEvalOnStop) return;
  try {
    await stat(path.join(agentDir, traceInput));
  } catch {
    console.warn("[demo] no trace JSONL found; skipping trace eval summary");
    return;
  }

  console.log("[demo] generating trace eval summary");
  const code = await runOneShot("trace-eval", ["npm", "run", "eval:traces", "--", traceInput, traceSummary], agentDir, env);
  if (code !== 0) console.warn(`[demo] trace eval exited with code ${code}; review traces before presenting`);
}

function startComponent(spec: ComponentSpec, env: NodeJS.ProcessEnv): RunningComponent {
  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.pid) throw new Error(`failed to start ${spec.component}`);
  prefixLogs(spec.component, child.stdout, process.stdout);
  prefixLogs(spec.component, child.stderr, process.stderr);

  const record: DemoProcessRecord = {
    component: spec.component,
    pid: child.pid,
    command: spec.command,
    cwd: spec.cwd,
    port: spec.port,
    startedAt: new Date().toISOString(),
  };

  return { child, record };
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(800, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  const options = parseDemoArgs(process.argv.slice(2));
  const env = loadEnv();
  const missing = missingRequiredEnv(options, env);
  if (missing.length) throw new Error(`missing required env for selected demo components: ${missing.join(", ")}`);

  if (options.freshTrace) await rm(path.join(agentDir, traceInput), { force: true });

  const active = await cleanStaleProcessRecords(repoRoot);
  const requestedComponents = new Set<DemoComponent>(["orchestrator", ...selectedSpecs(options).map((spec) => spec.component)]);
  const duplicates = active.filter((record) => requestedComponents.has(record.component));
  if (duplicates.length) {
    throw new Error(`demo component already running: ${duplicates.map((record) => `${record.component} pid=${record.pid}`).join(", ")}`);
  }

  await maybeRunScenarioEval(options, env);

  const orchestratorRecord: DemoProcessRecord = {
    component: "orchestrator",
    pid: process.pid,
    command: ["npm", "run", "demo"],
    cwd: agentDir,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    port: options.dashboard ? options.port : undefined,
  };
  await writeProcessRecord(repoRoot, orchestratorRecord);

  const running: RunningComponent[] = [];
  let shuttingDown = false;
  let exitCode = 0;

  const heartbeat = setInterval(async () => {
    const current = await readProcessRecord(repoRoot, "orchestrator");
    if (current && isPidRunning(current.pid)) {
      await writeProcessRecord(repoRoot, { ...current, heartbeatAt: new Date().toISOString() });
    }
  }, 10_000);

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    clearInterval(heartbeat);
    console.log("[demo] stopping components");

    for (const item of [...running].reverse()) {
      terminateProcessRecord(item.record, "SIGTERM");
    }
    await sleep(1_200);
    for (const item of [...running].reverse()) {
      if (isPidRunning(item.record.pid)) terminateProcessRecord(item.record, "SIGKILL");
      await removeProcessRecord(repoRoot, item.record.component);
    }

    await maybeRunTraceEval(options, env);
    await removeProcessRecord(repoRoot, "orchestrator");
    process.exit(exitCode);
  }

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  for (const spec of selectedSpecs(options)) {
    const component = startComponent(spec, env);
    running.push(component);
    await writeProcessRecord(repoRoot, component.record);
    component.child.on("exit", (code, signal) => {
      void removeProcessRecord(repoRoot, component.record.component);
      if (!shuttingDown) {
        console.error(`[demo] ${component.record.component} exited early`, { code, signal });
        void shutdown(code && code > 0 ? code : 1);
      }
    });
    console.log(`[demo] started ${spec.component} pid=${component.record.pid}`);
  }

  if (options.dashboard) {
    const ready = await waitForPort(options.port);
    console.log(ready ? `[demo] dashboard ready at http://localhost:${options.port}` : `[demo] dashboard port ${options.port} did not open yet`);
  }

  console.log("[demo] running. Press Ctrl-C to stop and write eval summaries.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as Error;
    console.error(`[demo] ${e.message}`);
    process.exit(1);
  });
}
