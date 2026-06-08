import type {
  LendingHealthFinding,
  LendingHealthLimits,
  LendingHealthReport,
  LendingMarketSnapshot,
  LendingPositionSnapshot,
} from "./types.js";

export const DEFAULT_LENDING_HEALTH_LIMITS: LendingHealthLimits = {
  minHealthFactorBps: 15_000n,
  warnHealthFactorBps: 18_000n,
  maxMarketUtilizationBps: 9_000n,
  maxCapUsageBps: 9_500n,
};

const BPS = 10_000n;

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function bps(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator * BPS) / denominator;
}

function finding(
  ruleId: LendingHealthFinding["ruleId"],
  severity: LendingHealthFinding["severity"],
  reason: string,
): LendingHealthFinding {
  return { ruleId, severity, reason };
}

function suppliedValueWei(position: LendingPositionSnapshot): bigint {
  return sum(position.assets.map((asset) => asset.suppliedValueWei));
}

function debtValueWei(position: LendingPositionSnapshot): bigint {
  return sum(position.assets.map((asset) => asset.debtValueWei));
}

function collateralAtThresholdWei(position: LendingPositionSnapshot): bigint {
  return sum(position.assets.map((asset) => (asset.suppliedValueWei * asset.liquidationThresholdBps) / BPS));
}

export function weightedLiquidationThresholdBps(position: LendingPositionSnapshot): bigint {
  const supplied = suppliedValueWei(position);
  if (supplied <= 0n) return 0n;
  return bps(collateralAtThresholdWei(position), supplied);
}

export function healthFactorBps(position: LendingPositionSnapshot): bigint | undefined {
  const debt = debtValueWei(position);
  if (debt <= 0n) return undefined;
  return bps(collateralAtThresholdWei(position), debt);
}

function marketFindings(markets: readonly LendingMarketSnapshot[], limits: LendingHealthLimits): LendingHealthFinding[] {
  const findings: LendingHealthFinding[] = [];

  for (const market of markets) {
    if (market.paused) {
      findings.push(
        finding("LENDING_MARKET_PAUSED", "critical", `${market.protocolId}:${market.symbol} market is paused`),
      );
    }
    if (market.frozen) {
      findings.push(
        finding("LENDING_MARKET_FROZEN", "blocker", `${market.protocolId}:${market.symbol} market is frozen`),
      );
    }
    if (market.utilizationBps !== undefined && market.utilizationBps > limits.maxMarketUtilizationBps) {
      findings.push(
        finding(
          "LENDING_MARKET_UTILIZATION_HIGH",
          "warning",
          `${market.protocolId}:${market.symbol} utilization ${market.utilizationBps} bps exceeds ${limits.maxMarketUtilizationBps} bps`,
        ),
      );
    }
    if (market.supplyCapUsedBps !== undefined && market.supplyCapUsedBps > limits.maxCapUsageBps) {
      findings.push(
        finding(
          "LENDING_CAP_USAGE_HIGH",
          "warning",
          `${market.protocolId}:${market.symbol} supply cap usage ${market.supplyCapUsedBps} bps exceeds ${limits.maxCapUsageBps} bps`,
        ),
      );
    }
    if (market.borrowCapUsedBps !== undefined && market.borrowCapUsedBps > limits.maxCapUsageBps) {
      findings.push(
        finding(
          "LENDING_CAP_USAGE_HIGH",
          "warning",
          `${market.protocolId}:${market.symbol} borrow cap usage ${market.borrowCapUsedBps} bps exceeds ${limits.maxCapUsageBps} bps`,
        ),
      );
    }
  }

  return findings;
}

function nextSteps(report: Pick<LendingHealthReport, "assets" | "debtValueWei" | "findings">): string[] {
  const steps = [];
  if (report.assets.length === 0) steps.push("Configure read-only Lendle or INIT position inputs before demoing lending risk.");
  if (report.debtValueWei > 0n) steps.push("Add oracle freshness checks for every collateral and debt asset.");
  if (report.findings.some((item) => item.ruleId === "LENDING_HEALTH_FACTOR_LOW")) {
    steps.push("Block borrow/withdraw actions until health factor is restored above the minimum.");
  }
  if (report.findings.some((item) => item.ruleId === "LENDING_MARKET_UTILIZATION_HIGH")) {
    steps.push("Treat high-utilization markets as withdraw-risk or borrow-risk warnings.");
  }
  steps.push("Keep lending execution disabled until health-factor simulation and liquidation edge-case tests pass.");
  return steps;
}

export function evaluateLendingHealth(
  position: LendingPositionSnapshot,
  markets: readonly LendingMarketSnapshot[] = [],
  limits: LendingHealthLimits = DEFAULT_LENDING_HEALTH_LIMITS,
): LendingHealthReport {
  const supplied = suppliedValueWei(position);
  const debt = debtValueWei(position);
  const threshold = weightedLiquidationThresholdBps(position);
  const collateral = collateralAtThresholdWei(position);
  const health = healthFactorBps(position);
  const findings = marketFindings(markets, limits);

  if (position.assets.length === 0) {
    findings.push(
      finding(
        "LENDING_NOT_CONFIGURED",
        "warning",
        "No read-only lending position is configured; lending execution must stay disabled.",
      ),
    );
  }

  if (debt > 0n && health === undefined) {
    findings.push(
      finding("LENDING_HEALTH_FACTOR_MISSING", "critical", "Debt exists but health factor cannot be computed."),
    );
  } else if (health !== undefined && health < limits.minHealthFactorBps) {
    findings.push(
      finding(
        "LENDING_HEALTH_FACTOR_LOW",
        "critical",
        `health factor ${health} bps is below ${limits.minHealthFactorBps} bps minimum`,
      ),
    );
  } else if (health !== undefined && health < limits.warnHealthFactorBps) {
    findings.push(
      finding(
        "LENDING_HEALTH_FACTOR_WARN",
        "warning",
        `health factor ${health} bps is below ${limits.warnHealthFactorBps} bps warning threshold`,
      ),
    );
  }

  const hardBlock = findings.some((item) => item.severity === "critical" || item.severity === "blocker");
  const status: LendingHealthReport["status"] = hardBlock ? "blocked" : findings.length ? "watch" : "healthy";
  const report = {
    ok: !hardBlock,
    protocolId: position.protocolId,
    mode: "read-only-health" as const,
    executionEnabled: false as const,
    status,
    account: position.account,
    suppliedValueWei: supplied,
    debtValueWei: debt,
    weightedLiquidationThresholdBps: threshold,
    collateralAtThresholdWei: collateral,
    healthFactorBps: health,
    liquidationBufferBps: health === undefined ? undefined : health - BPS,
    marketsChecked: markets.length,
    assets: position.assets,
    findings,
  };

  return {
    ...report,
    nextSteps: nextSteps(report),
  };
}
