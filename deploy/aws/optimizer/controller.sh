#!/usr/bin/env bash

build_optimizer_codex_args() {
  local root="$1"
  local workspace="$2"
  local model="$3"
  local result_path="$4"

  OPTIMIZER_CODEX_ARGS=(
    exec
    --ephemeral
    --ignore-user-config
    --ignore-rules
    --dangerously-bypass-approvals-and-sandbox
    -C "$workspace"
    -m "$model"
    -c 'shell_environment_policy.inherit="core"'
    -c 'shell_environment_policy.ignore_default_excludes=false'
    -c 'shell_environment_policy.exclude=["AWS_*","CODEX_*","OPENAI_*"]'
    -c "model_instructions_file=\"$root/deploy/aws/optimizer/codex-base-instructions.md\""
    -c 'model_reasoning_effort="low"'
    -c 'model_verbosity="low"'
    -c 'tool_output_token_limit=1500'
    --output-schema "$workspace/deploy/aws/optimizer/codex-result.schema.json"
    --output-last-message "$result_path"
    --json
  )
}

optimizer_link_agent_dependencies() {
  local root="$1"
  local workspace="$2"
  ln -s "$root/agent/node_modules" "$workspace/agent/node_modules"
}

optimizer_codex_failure_detail() {
  local events_path="$1"
  local exit_status="$2"

  node - "$events_path" "$exit_status" <<'NODE'
const fs = require("node:fs");
const [eventsPath, exitStatus] = process.argv.slice(2);
let detail = `codex exec exited ${exitStatus}`;

if (fs.existsSync(eventsPath)) {
  for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const message = event.error?.message ?? event.message;
      if ((event.type === "turn.failed" || event.type === "error") && message) {
        detail = message;
      }
    } catch {
      // Preserve the exit-status fallback when a partial JSONL line is present.
    }
  }
}

process.stdout.write(detail);
NODE
}

optimizer_codex_failure_is_nonretryable() {
  local events_path="$1"
  grep -Eq 'Request too large.*tokens per min \(TPM\)' "$events_path"
}
