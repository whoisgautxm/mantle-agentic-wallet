import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

export const DEMO_COMPONENTS = ["orchestrator", "keeper", "agent", "baseline", "web"] as const;
export type DemoComponent = (typeof DEMO_COMPONENTS)[number];

export interface DemoProcessRecord {
  component: DemoComponent;
  pid: number;
  command: string[];
  cwd: string;
  startedAt: string;
  heartbeatAt?: string;
  port?: number;
}

export function runtimeDir(repoRoot: string): string {
  return path.join(repoRoot, ".runtime");
}

export function recordPath(repoRoot: string, component: DemoComponent): string {
  return path.join(runtimeDir(repoRoot), `demo-${component}.json`);
}

export async function ensureRuntimeDir(repoRoot: string): Promise<void> {
  await mkdir(runtimeDir(repoRoot), { recursive: true });
}

export async function writeProcessRecord(repoRoot: string, record: DemoProcessRecord): Promise<void> {
  await ensureRuntimeDir(repoRoot);
  await writeFile(recordPath(repoRoot, record.component), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readProcessRecord(
  repoRoot: string,
  component: DemoComponent,
): Promise<DemoProcessRecord | undefined> {
  try {
    return JSON.parse(await readFile(recordPath(repoRoot, component), "utf8")) as DemoProcessRecord;
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readAllProcessRecords(repoRoot: string): Promise<DemoProcessRecord[]> {
  const records = await Promise.all(DEMO_COMPONENTS.map((component) => readProcessRecord(repoRoot, component)));
  return records.filter((record): record is DemoProcessRecord => record !== undefined);
}

export async function removeProcessRecord(repoRoot: string, component: DemoComponent): Promise<void> {
  await rm(recordPath(repoRoot, component), { force: true });
}

export function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

export async function cleanStaleProcessRecords(repoRoot: string): Promise<DemoProcessRecord[]> {
  const records = await readAllProcessRecords(repoRoot);
  const active: DemoProcessRecord[] = [];
  for (const record of records) {
    if (isPidRunning(record.pid)) {
      active.push(record);
    } else {
      await removeProcessRecord(repoRoot, record.component);
    }
  }
  return active;
}

export function terminateProcessRecord(record: DemoProcessRecord, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!isPidRunning(record.pid)) return false;

  if (process.platform !== "win32" && record.component !== "orchestrator") {
    try {
      process.kill(-record.pid, signal);
      return true;
    } catch {
      // Fall back to killing the direct PID below. This covers non-detached records.
    }
  }

  try {
    process.kill(record.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function formatAge(fromIso: string, now = Date.now()): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
