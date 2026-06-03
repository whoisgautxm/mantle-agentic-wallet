import { formatMnt, type StatusResult } from "../../lib/status";

export default function OraclePanel({ status }: { status: StatusResult }) {
  if (status.ok === false) {
    return (
      <section className="insight-card">
        <p className="eyebrow">Oracle status</p>
        <h2>Unavailable</h2>
        <p className="muted">{status.reason}</p>
      </section>
    );
  }

  return (
    <section className="insight-card">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Oracle status</p>
          <h2>{status.oracle.pair}</h2>
        </div>
        <span className="badge ok">Fresh</span>
      </div>
      <div className="metric-grid">
        <div>
          <span>Source</span>
          <strong>{status.oracle.source}</strong>
        </div>
        <div>
          <span>Reference price</span>
          <strong>{formatMnt(status.oracle.priceWei)}</strong>
        </div>
        <div>
          <span>DEX deviation</span>
          <strong>{status.oracle.dexOracleDeviationBps.toString()} bps</strong>
        </div>
        <div>
          <span>Checked</span>
          <strong>{new Date(status.oracle.updatedAt).toLocaleTimeString("en-US", { hour12: false })}</strong>
        </div>
      </div>
      <p className="muted panel-note">
        Current source is the MockDEX reference price. This panel is ready for Pyth/Chainlink freshness and deviation checks next.
      </p>
    </section>
  );
}
