import { formatBps, formatMnt, type StatusResult, type VaultStatus } from "../../lib/status";

function vaultBadge(vault: VaultStatus, maxPositionBps: bigint): "ok" | "warn" | "bad" {
  if (vault.paused || !vault.dexAllowed) return "bad";
  if (vault.positionBps >= (maxPositionBps * 8n) / 10n) return "warn";
  return "ok";
}

function label(kind: "ok" | "warn" | "bad"): string {
  if (kind === "bad") return "Blocked";
  if (kind === "warn") return "Near limit";
  return "Ready";
}

function VaultRiskRow({ name, vault, maxPositionBps }: { name: string; vault: VaultStatus; maxPositionBps: bigint }) {
  const kind = vaultBadge(vault, maxPositionBps);
  return (
    <div className="risk-row">
      <div>
        <strong>{name}</strong>
        <span>{vault.dexAllowed ? "DEX allowlisted" : "DEX not allowlisted"}</span>
      </div>
      <div>
        <span>Portfolio</span>
        <strong>{formatMnt(vault.portfolioWei)}</strong>
      </div>
      <div>
        <span>Token exposure</span>
        <strong>{formatBps(vault.positionBps)}</strong>
      </div>
      <div>
        <span>Daily room</span>
        <strong>{formatMnt(vault.dailyRemaining)}</strong>
      </div>
      <span className={`badge ${kind}`}>{label(kind)}</span>
    </div>
  );
}

export default function RiskPanel({ status }: { status: StatusResult }) {
  if (status.ok === false) {
    return (
      <section className="insight-card">
        <p className="eyebrow">Risk engine</p>
        <h2>Waiting for live reads</h2>
        <p className="muted">{status.reason}</p>
      </section>
    );
  }

  const { config, ai, baseline } = status.risk;
  return (
    <section className="insight-card wide">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Risk engine</p>
          <h2>Live guardrail posture</h2>
        </div>
        <span className="badge ok">Simulation-gated</span>
      </div>
      <div className="limit-strip">
        <span>Quote/oracle max deviation: {config.maxDexOracleDeviationBps.toString()} bps</span>
        <span>Max position: {formatBps(config.maxPositionBps)}</span>
        <span>Max trade: {formatBps(config.maxTradeValueBps)}</span>
      </div>
      <VaultRiskRow name="AI vault" vault={ai} maxPositionBps={config.maxPositionBps} />
      <VaultRiskRow name="Baseline vault" vault={baseline} maxPositionBps={config.maxPositionBps} />
    </section>
  );
}
