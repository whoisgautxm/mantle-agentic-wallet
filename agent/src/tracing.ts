import { mkdir, appendFile } from "fs/promises";
import path from "path";

export interface JsonlTraceWriter {
  enabled: boolean;
  path: string;
  append(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface TraceWriterOptions {
  enabled?: boolean;
  path?: string;
  env?: NodeJS.ProcessEnv;
}

function defaultTracePath(env: NodeJS.ProcessEnv): string {
  return env.TRACE_JSONL_PATH ?? path.join(env.TRACE_DIR ?? "traces", "agent-events.jsonl");
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => typeof entry !== "function" && entry !== undefined)
        .map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

export function createJsonlTraceWriter(options: TraceWriterOptions = {}): JsonlTraceWriter {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.TRACE_ENABLED !== "false";
  const tracePath = options.path ?? defaultTracePath(env);

  return {
    enabled,
    path: tracePath,
    async append(type: string, payload: Record<string, unknown>): Promise<void> {
      if (!enabled) return;
      await mkdir(path.dirname(tracePath), { recursive: true });
      const line = JSON.stringify(
        jsonSafe({
          ts: new Date().toISOString(),
          type,
          ...payload,
        }),
      );
      await appendFile(tracePath, `${line}\n`, "utf8");
    },
  };
}
