import path from "path";
import { pathToFileURL } from "url";
import {
  DEMO_COMPONENTS,
  isPidRunning,
  readAllProcessRecords,
  removeProcessRecord,
  sleep,
  terminateProcessRecord,
  type DemoComponent,
  type DemoProcessRecord,
} from "./runtime/demoRuntime.js";

const repoRoot = path.resolve(process.cwd(), "..");
const stopOrder: DemoComponent[] = ["agent", "baseline", "keeper", "web", "orchestrator"];

function byStopOrder(records: DemoProcessRecord[]): DemoProcessRecord[] {
  return [...records].sort((a, b) => stopOrder.indexOf(a.component) - stopOrder.indexOf(b.component));
}

async function main(): Promise<void> {
  const records = byStopOrder(await readAllProcessRecords(repoRoot));
  if (records.length === 0) {
    console.log("[demo:stop] no demo runtime records found");
    return;
  }

  for (const record of records) {
    if (record.pid === process.pid) continue;
    if (isPidRunning(record.pid)) {
      const signaled = terminateProcessRecord(record, "SIGTERM");
      console.log(`[demo:stop] ${signaled ? "sent SIGTERM to" : "could not signal"} ${record.component} pid=${record.pid}`);
    }
  }

  await sleep(1_200);

  for (const record of records) {
    if (record.pid !== process.pid && isPidRunning(record.pid)) {
      const killed = terminateProcessRecord(record, "SIGKILL");
      console.log(`[demo:stop] ${killed ? "sent SIGKILL to" : "could not kill"} ${record.component} pid=${record.pid}`);
    }
    await removeProcessRecord(repoRoot, record.component);
  }

  for (const component of DEMO_COMPONENTS) {
    await removeProcessRecord(repoRoot, component);
  }

  console.log("[demo:stop] stopped demo runtime");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as Error;
    console.error(`[demo:stop] ${e.message}`);
    process.exit(1);
  });
}
