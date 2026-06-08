import addresses from "../../shared/addresses.json";
import type { PortfolioStatus } from "./portfolio";
import type { StatusResult } from "./status";

type ReadinessKind = "ok" | "warn" | "bad";

export interface ProtocolReadinessItem {
  name: string;
  mode: string;
  status: ReadinessKind;
  label: string;
  detail: string;
  target?: string;
}

export interface ProtocolReadiness {
  items: ProtocolReadinessItem[];
}

function short(address: string | undefined): string | undefined {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function oracleItem(status: StatusResult): ProtocolReadinessItem {
  const provider = (process.env.ORACLE_PROVIDER ?? "mockdex").toLowerCase();
  if (status.ok && status.oracle.source === "Pyth") {
    return {
      name: "Pyth Hermes",
      mode: "read-only oracle",
      status: status.oracle.stale ? "bad" : "ok",
      label: status.oracle.stale ? "Stale" : "Active",
      detail: `MNT/USD reference active with ${status.oracle.dexOracleDeviationBps.toString()} bps DEX deviation.`,
    };
  }
  if (provider === "pyth") {
    return {
      name: "Pyth Hermes",
      mode: "read-only oracle",
      status: "warn",
      label: "Fallback",
      detail: status.ok ? "Configured but currently using MockDEX fallback." : "Configured but live oracle status is unavailable.",
    };
  }
  return {
    name: "Pyth Hermes",
    mode: "read-only oracle",
    status: "warn",
    label: "Standby",
    detail: "Set ORACLE_PROVIDER=pyth to use the external MNT/USD reference.",
  };
}

function allowanceItem(portfolio: PortfolioStatus): ProtocolReadinessItem {
  if (portfolio.ok === false) {
    return {
      name: "ERC20 allowances",
      mode: "risk foundation",
      status: "bad",
      label: "Unavailable",
      detail: portfolio.reason,
    };
  }
  if (!portfolio.configured) {
    return {
      name: "ERC20 allowances",
      mode: "risk foundation",
      status: "warn",
      label: "No tokens",
      detail: "PORTFOLIO_TOKENS is empty, so real token balances and allowances are not yet watched.",
    };
  }
  const unsafe = portfolio.allowances.filter((row) => row.unsafe).length;
  return {
    name: "ERC20 allowances",
    mode: "risk foundation",
    status: unsafe > 0 ? "bad" : "ok",
    label: unsafe > 0 ? `${unsafe} unsafe` : "Watching",
    detail: `${portfolio.tokens.length} token(s), ${portfolio.spenders.length} spender(s), ${portfolio.allowances.length} allowance checks.`,
  };
}

export function getProtocolReadiness(status: StatusResult, portfolio: PortfolioStatus): ProtocolReadiness {
  const dex = addresses.mockDex as string | undefined;
  const mockDexReady =
    status.ok &&
    status.risk.ai.dexAllowed &&
    status.risk.ai.dexGuarded &&
    status.risk.baseline.dexAllowed &&
    status.risk.baseline.dexGuarded;
  const merchantMoeConfigured = hasEnv("MERCHANT_MOE_LB_QUOTER") && hasEnv("MERCHANT_MOE_LB_ROUTER");
  const merchantMoeSpenderConfigured =
    process.env.PORTFOLIO_SPENDERS?.toLowerCase().includes("merchantmoelbrouter") ?? false;

  return {
    items: [
      {
        name: "MockDEX",
        mode: "executable demo venue",
        status: mockDexReady ? "ok" : "bad",
        label: mockDexReady ? "Executable" : "Blocked",
        detail: status.ok
          ? "AI and baseline vaults both allowlist the DEX and require guarded execution."
          : "Waiting for live vault allowlist reads.",
        target: short(dex),
      },
      {
        name: "Merchant Moe",
        mode: "read-only DEX adapter",
        status: merchantMoeConfigured ? "warn" : "bad",
        label: merchantMoeConfigured ? "Read-only" : "Missing env",
        detail: merchantMoeConfigured
          ? merchantMoeSpenderConfigured
            ? "LBQuoter/router configured; execution intentionally disabled until fork simulation."
            : "Quote contracts configured; add Merchant Moe router to PORTFOLIO_SPENDERS for allowance watch."
          : "Set MERCHANT_MOE_LB_QUOTER and MERCHANT_MOE_LB_ROUTER before quote smoke tests.",
        target: short(process.env.MERCHANT_MOE_LB_ROUTER),
      },
      oracleItem(status),
      {
        name: "Simulation gate",
        mode: "execution preflight",
        status: "ok",
        label: "Enabled",
        detail: "submitExecute requires a passing AgentVault.executeGuarded simulation before writeContract.",
      },
      allowanceItem(portfolio),
    ],
  };
}
