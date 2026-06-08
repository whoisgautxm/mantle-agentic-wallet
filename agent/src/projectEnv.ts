import { existsSync } from "fs";
import path from "path";
import { config as loadDotenv } from "dotenv";

export function resolveProjectRoot(cwd = process.cwd()): string {
  if (path.basename(cwd) === "agent" && existsSync(path.join(cwd, "package.json"))) {
    return path.dirname(cwd);
  }
  if (existsSync(path.join(cwd, "agent", "package.json"))) return cwd;
  return path.resolve(cwd, "..");
}

export function loadProjectEnv(cwd = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  loadDotenv({ path: path.join(root, ".env") });
  loadDotenv({ path: path.join(root, "agent", ".env") });
  return root;
}
