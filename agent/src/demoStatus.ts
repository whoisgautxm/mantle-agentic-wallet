import path from "path";
import { pathToFileURL } from "url";
import { formatAge, isPidRunning, readAllProcessRecords } from "./runtime/demoRuntime.js";

const repoRoot = path.resolve(process.cwd(), "..");

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

async function main(): Promise<void> {
  const records = await readAllProcessRecords(repoRoot);
  if (records.length === 0) {
    console.log("No demo runtime records found.");
    return;
  }

  console.log(
    [
      pad("Component", 13),
      pad("PID", 8),
      pad("Status", 8),
      pad("Age", 8),
      pad("Heartbeat", 11),
      "Command",
    ].join(" "),
  );
  console.log("-".repeat(86));

  for (const record of records.sort((a, b) => a.component.localeCompare(b.component))) {
    const alive = isPidRunning(record.pid);
    const heartbeat = record.heartbeatAt ? formatAge(record.heartbeatAt) : "-";
    const command = `${record.command.join(" ")}${record.port ? ` (port ${record.port})` : ""}`;
    console.log(
      [
        pad(record.component, 13),
        pad(record.pid.toString(), 8),
        pad(alive ? "running" : "stale", 8),
        pad(formatAge(record.startedAt), 8),
        pad(heartbeat, 11),
        command,
      ].join(" "),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as Error;
    console.error(`[demo:status] ${e.message}`);
    process.exit(1);
  });
}
