type MerchantMoeLiveCapStatus =
  | "disabled"
  | "ready-disabled"
  | "eligible"
  | "blocked";

interface MerchantMoeLiveCapFinding {
  ruleId: string;
  severity: "warning" | "blocker";
  reason: string;
}

interface MerchantMoeLiveCapPolicy {
  executionSwitchEnabled: boolean;
  maxAmountInWei?: string;
  maxSlippageBps?: string;
  maxQuoteDeviationBps?: string;
  maxAllowanceMultipleBps: string;
  requireAnvilForkPass: boolean;
  requireGuardedVaultExecution: boolean;
  requireAutoCalldata: boolean;
  requireBoundedAllowance: boolean;
  requireZeroNativeValue: boolean;
}

export interface MerchantMoeLiveCapReport {
  status: MerchantMoeLiveCapStatus;
  eligible: boolean;
  executionEnabled: boolean;
  policy: MerchantMoeLiveCapPolicy;
  blockers: MerchantMoeLiveCapFinding[];
  warnings: MerchantMoeLiveCapFinding[];
  reason: string;
}

export interface MerchantMoeLiveCapReportInput {
  ok?: boolean;
  fixtureKind?: "deterministic" | "anvil-mainnet-fork";
  simulationMode?: string;
  simulationPassed?: boolean;
  calldataSource?: string;
  amountIn?: string | number | bigint;
  minOutWei?: string | number | bigint;
  slippageBps?: string | number | bigint;
  valueWei?: string | number | bigint;
  quoteRisk?: {
    status?: "unchecked" | "ok" | "blocked";
    deviationBps?: string | number | bigint;
    maxDeviationBps?: string | number | bigint;
    reason?: string;
  };
  preflight?: {
    requiredAmountIn?: string | number | bigint;
    allowanceRaw?: string | number | bigint;
    allowanceStatus?: string;
    balanceOk?: boolean;
    allowanceOk?: boolean;
  };
  vaultEvidence?: {
    paused?: boolean;
    tokenAllowed?: boolean;
    routerAllowed?: boolean;
    routerGuarded?: boolean;
  };
  forkExecution?: {
    attempted?: boolean;
    passed?: boolean;
    vaultFunction?: string;
    tokenOutDelta?: string | number | bigint;
    agentDecisionEvents?: string | number | bigint;
  };
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw?.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`expected boolean value, received ${raw}`);
}

function parseOptionalUnsigned(
  raw: string | undefined,
  label: string,
): bigint | undefined {
  if (!raw?.trim()) return undefined;
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw.trim());
}

function parseReportUnsigned(
  raw: string | number | bigint | undefined,
  label: string,
): bigint | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw);
  if (!/^\d+$/.test(value))
    throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function parsePolicy(env: NodeJS.ProcessEnv): MerchantMoeLiveCapPolicy {
  const maxAmountInWei = parseOptionalUnsigned(
    env.MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI,
    "MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI",
  );
  const maxSlippageBps = parseOptionalUnsigned(
    env.MERCHANT_MOE_LIVE_MAX_SLIPPAGE_BPS,
    "MERCHANT_MOE_LIVE_MAX_SLIPPAGE_BPS",
  );
  const maxQuoteDeviationBps = parseOptionalUnsigned(
    env.MERCHANT_MOE_LIVE_MAX_DEVIATION_BPS,
    "MERCHANT_MOE_LIVE_MAX_DEVIATION_BPS",
  );
  const maxAllowanceMultipleBps =
    parseOptionalUnsigned(
      env.MERCHANT_MOE_LIVE_MAX_ALLOWANCE_MULTIPLE_BPS,
      "MERCHANT_MOE_LIVE_MAX_ALLOWANCE_MULTIPLE_BPS",
    ) ?? 10_000n;
  if (maxAllowanceMultipleBps <= 0n) {
    throw new Error(
      "MERCHANT_MOE_LIVE_MAX_ALLOWANCE_MULTIPLE_BPS must be positive",
    );
  }

  return {
    executionSwitchEnabled: parseBoolean(
      env.MERCHANT_MOE_LIVE_EXECUTION_ENABLED,
      false,
    ),
    maxAmountInWei: maxAmountInWei?.toString(),
    maxSlippageBps: maxSlippageBps?.toString(),
    maxQuoteDeviationBps: maxQuoteDeviationBps?.toString(),
    maxAllowanceMultipleBps: maxAllowanceMultipleBps.toString(),
    requireAnvilForkPass: parseBoolean(
      env.MERCHANT_MOE_LIVE_REQUIRE_ANVIL_FORK_PASS,
      true,
    ),
    requireGuardedVaultExecution: parseBoolean(
      env.MERCHANT_MOE_LIVE_REQUIRE_GUARDED_VAULT,
      true,
    ),
    requireAutoCalldata: parseBoolean(
      env.MERCHANT_MOE_LIVE_REQUIRE_AUTO_CALLDATA,
      true,
    ),
    requireBoundedAllowance: parseBoolean(
      env.MERCHANT_MOE_LIVE_REQUIRE_BOUNDED_ALLOWANCE,
      true,
    ),
    requireZeroNativeValue: parseBoolean(
      env.MERCHANT_MOE_LIVE_REQUIRE_ZERO_NATIVE_VALUE,
      true,
    ),
  };
}

function finding(
  ruleId: string,
  reason: string,
  severity: "warning" | "blocker" = "blocker",
): MerchantMoeLiveCapFinding {
  return { ruleId, severity, reason };
}

function compareCap(
  blockers: MerchantMoeLiveCapFinding[],
  reportValue: bigint | undefined,
  capValue: string | undefined,
  reportLabel: string,
  capEnvName: string,
): void {
  if (reportValue === undefined) {
    blockers.push(
      finding(
        `${reportLabel.toUpperCase()}_MISSING`,
        `${reportLabel} was not captured in the fork report.`,
      ),
    );
    return;
  }
  if (capValue === undefined) {
    blockers.push(
      finding(
        `${capEnvName}_MISSING`,
        `Set ${capEnvName} before enabling bounded live Merchant Moe execution.`,
      ),
    );
    return;
  }
  const cap = BigInt(capValue);
  if (reportValue > cap) {
    blockers.push(
      finding(
        `${capEnvName}_EXCEEDED`,
        `${reportLabel} ${reportValue} exceeds cap ${cap}.`,
      ),
    );
  }
}

function optionalQuoteDeviationCap(
  report: MerchantMoeLiveCapReportInput,
  policy: MerchantMoeLiveCapPolicy,
): string | undefined {
  return (
    policy.maxQuoteDeviationBps ?? report.quoteRisk?.maxDeviationBps?.toString()
  );
}

function reason(
  status: MerchantMoeLiveCapStatus,
  blockers: readonly MerchantMoeLiveCapFinding[],
): string {
  if (status === "eligible")
    return "Bounded live-cap policy is enabled and every cap passed.";
  if (status === "ready-disabled")
    return "All bounded live caps passed, but MERCHANT_MOE_LIVE_EXECUTION_ENABLED is false.";
  if (status === "blocked")
    return (
      blockers[0]?.reason ?? "Live execution is blocked by bounded cap policy."
    );
  return (
    blockers[0]?.reason ??
    "Live execution is disabled until bounded caps and fork evidence pass."
  );
}

export function evaluateMerchantMoeLiveCaps(
  report: MerchantMoeLiveCapReportInput,
  env: NodeJS.ProcessEnv = process.env,
): MerchantMoeLiveCapReport {
  const policy = parsePolicy(env);
  const blockers: MerchantMoeLiveCapFinding[] = [];
  const warnings: MerchantMoeLiveCapFinding[] = [];

  if (!report.ok) {
    blockers.push(
      finding(
        "LIVE_CAP_REPORT_NOT_OK",
        "The Merchant Moe fork report is not green.",
      ),
    );
  }
  if (!report.simulationPassed) {
    blockers.push(
      finding(
        "LIVE_CAP_SIMULATION_NOT_PASSED",
        "AgentVault simulation must pass before live eligibility.",
      ),
    );
  }
  if (
    policy.requireAnvilForkPass &&
    (report.fixtureKind !== "anvil-mainnet-fork" ||
      report.forkExecution?.passed !== true)
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_ANVIL_FORK_EXECUTION_REQUIRED",
        "Run the Anvil Mantle-mainnet fork fixture and pass the fork-local AgentVault swap before live eligibility.",
      ),
    );
  }
  if (policy.requireGuardedVaultExecution) {
    if (report.simulationMode !== "vault-execute") {
      blockers.push(
        finding(
          "LIVE_CAP_VAULT_MODE_REQUIRED",
          "Live eligibility requires vault-execute simulation mode.",
        ),
      );
    }
    if (report.forkExecution?.vaultFunction !== "executeGuarded") {
      blockers.push(
        finding(
          "LIVE_CAP_GUARDED_EXECUTION_REQUIRED",
          "Merchant Moe router swaps must use AgentVault.executeGuarded.",
        ),
      );
    }
  }
  if (policy.requireAutoCalldata && report.calldataSource !== "auto") {
    blockers.push(
      finding(
        "LIVE_CAP_AUTO_CALLDATA_REQUIRED",
        "Live eligibility requires code-built calldata, not model/env-authored bytes.",
      ),
    );
  }
  if (policy.requireZeroNativeValue) {
    const valueWei = parseReportUnsigned(report.valueWei, "valueWei") ?? 0n;
    if (valueWei !== 0n) {
      blockers.push(
        finding(
          "LIVE_CAP_ZERO_NATIVE_VALUE_REQUIRED",
          `Merchant Moe WMNT router swaps must send valueWei=0, saw ${valueWei}.`,
        ),
      );
    }
  }

  const amountIn = parseReportUnsigned(report.amountIn, "amountIn");
  const slippageBps = parseReportUnsigned(report.slippageBps, "slippageBps");
  const deviationBps = parseReportUnsigned(
    report.quoteRisk?.deviationBps,
    "quoteRisk.deviationBps",
  );
  const maxQuoteDeviationBps = optionalQuoteDeviationCap(report, policy);
  compareCap(
    blockers,
    amountIn,
    policy.maxAmountInWei,
    "amountIn",
    "MERCHANT_MOE_LIVE_MAX_AMOUNT_IN_WEI",
  );
  compareCap(
    blockers,
    slippageBps,
    policy.maxSlippageBps,
    "slippageBps",
    "MERCHANT_MOE_LIVE_MAX_SLIPPAGE_BPS",
  );
  compareCap(
    blockers,
    deviationBps,
    maxQuoteDeviationBps,
    "quoteDeviationBps",
    "MERCHANT_MOE_LIVE_MAX_DEVIATION_BPS",
  );

  if (report.quoteRisk?.status !== "ok") {
    blockers.push(
      finding(
        "LIVE_CAP_QUOTE_RISK_NOT_OK",
        report.quoteRisk?.reason ?? "Quote/reference risk check must be ok.",
      ),
    );
  }
  if (report.preflight?.balanceOk !== true) {
    blockers.push(
      finding(
        "LIVE_CAP_BALANCE_NOT_OK",
        "Token-in balance preflight must pass.",
      ),
    );
  }
  if (report.preflight?.allowanceOk !== true) {
    blockers.push(
      finding(
        "LIVE_CAP_ALLOWANCE_NOT_OK",
        "Router allowance preflight must pass.",
      ),
    );
  }
  if (
    policy.requireBoundedAllowance &&
    report.preflight?.allowanceStatus !== "bounded"
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_BOUNDED_ALLOWANCE_REQUIRED",
        "Router allowance must be bounded, not missing/excessive/unbounded.",
      ),
    );
  }

  const allowanceRaw = parseReportUnsigned(
    report.preflight?.allowanceRaw,
    "allowanceRaw",
  );
  const requiredAmount =
    parseReportUnsigned(
      report.preflight?.requiredAmountIn,
      "requiredAmountIn",
    ) ?? amountIn;
  if (allowanceRaw !== undefined && requiredAmount !== undefined) {
    const maxAllowance =
      (requiredAmount * BigInt(policy.maxAllowanceMultipleBps)) / 10_000n;
    if (allowanceRaw > maxAllowance) {
      blockers.push(
        finding(
          "LIVE_CAP_ALLOWANCE_MULTIPLE_EXCEEDED",
          `Router allowance ${allowanceRaw} exceeds capped allowance ${maxAllowance}.`,
        ),
      );
    }
  }

  if (report.vaultEvidence?.paused !== false) {
    blockers.push(
      finding(
        "LIVE_CAP_VAULT_PAUSED_OR_UNKNOWN",
        "Vault must be unpaused in fork evidence.",
      ),
    );
  }
  if (
    report.vaultEvidence?.tokenAllowed !== true ||
    report.vaultEvidence?.routerAllowed !== true
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_VAULT_TARGETS_NOT_ALLOWED",
        "Vault must allow the token setup target and Merchant Moe router.",
      ),
    );
  }
  if (
    policy.requireGuardedVaultExecution &&
    report.vaultEvidence?.routerGuarded !== true
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_ROUTER_NOT_GUARDED",
        "Merchant Moe router must be marked guard-required in AgentVault.",
      ),
    );
  }

  const tokenOutDelta = parseReportUnsigned(
    report.forkExecution?.tokenOutDelta,
    "tokenOutDelta",
  );
  const minOutWei = parseReportUnsigned(report.minOutWei, "minOutWei");
  if (
    report.forkExecution?.passed &&
    tokenOutDelta !== undefined &&
    minOutWei !== undefined &&
    tokenOutDelta < minOutWei
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_OUTPUT_BELOW_MIN_OUT",
        `Fork output delta ${tokenOutDelta} is below minOut ${minOutWei}.`,
      ),
    );
  }
  if (
    report.forkExecution?.passed &&
    String(report.forkExecution.agentDecisionEvents ?? "") !== "1"
  ) {
    blockers.push(
      finding(
        "LIVE_CAP_AGENT_DECISION_EVENT_MISSING",
        "Fork execution must emit exactly one AgentDecision event.",
      ),
    );
  }

  warnings.push(
    finding(
      "LIVE_CAP_NO_MAINNET_SUBMISSION",
      "This policy only gates eligibility; the current Merchant Moe path still writes no live mainnet transaction.",
      "warning",
    ),
  );

  const eligible = blockers.length === 0;
  const executionEnabled = policy.executionSwitchEnabled && eligible;
  const status: MerchantMoeLiveCapStatus = policy.executionSwitchEnabled
    ? eligible
      ? "eligible"
      : "blocked"
    : eligible
      ? "ready-disabled"
      : "disabled";

  return {
    status,
    eligible,
    executionEnabled,
    policy,
    blockers,
    warnings,
    reason: reason(status, blockers),
  };
}
