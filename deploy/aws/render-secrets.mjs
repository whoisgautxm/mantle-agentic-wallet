#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [envPathArg = ".env", outputPathArg = "deploy/aws/.runtime/secrets.production.json"] = process.argv.slice(2);
const envPath = path.resolve(envPathArg);
const outputPath = path.resolve(outputPathArg);

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name]?.trim();
  if (!value || /REPLACE_ME|\.\.\.|SAMPLE|EKEY/i.test(value)) {
    throw new Error(`Missing or placeholder ${name} in ${envPath}`);
  }
  return value;
}

const values = parseEnv(await readFile(envPath, "utf8"));
const secret = {
  MANTLE_RPC_URL: required(values, "MANTLE_RPC_URL"),
  LOGS_RPC_URL: values.LOGS_RPC_URL?.trim() || "https://rpc.sepolia.mantle.xyz",
  AGENT_PRIVATE_KEY: required(values, "AGENT_PRIVATE_KEY"),
  BASELINE_PRIVATE_KEY: required(values, "BASELINE_PRIVATE_KEY"),
  OWNER_PRIVATE_KEY: required(values, "OWNER_PRIVATE_KEY"),
  OPENAI_API_KEY: required(values, "OPENAI_API_KEY"),
  PYTH_API_KEY: values.PYTH_API_KEY?.trim() || "",
  TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN?.trim() || "",
  TELEGRAM_CHAT_ID: values.TELEGRAM_CHAT_ID?.trim() || "",
};

await writeFile(outputPath, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`Rendered ${Object.keys(secret).length} secret fields to ${outputPath}`);
