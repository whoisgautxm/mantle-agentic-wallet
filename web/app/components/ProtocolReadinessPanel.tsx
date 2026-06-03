import type { ProtocolReadiness, ProtocolReadinessItem } from "../../lib/protocolReadiness";

function statusText(status: ProtocolReadinessItem["status"]): string {
  if (status === "ok") return "Ready";
  if (status === "bad") return "Blocked";
  return "Watch";
}

export default function ProtocolReadinessPanel({ readiness }: { readiness: ProtocolReadiness }) {
  const ready = readiness.items.filter((item) => item.status === "ok").length;
  return (
    <section className="insight-card wide">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Protocol readiness</p>
          <h2>Real-protocol runway</h2>
        </div>
        <span className="badge ok">
          {ready}/{readiness.items.length} ready
        </span>
      </div>

      <div className="protocol-list">
        {readiness.items.map((item) => (
          <div className="protocol-row" key={`${item.name}-${item.mode}`}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.mode}</span>
            </div>
            <div>
              <span>Target</span>
              <strong>{item.target ?? "n/a"}</strong>
            </div>
            <div>
              <span>State</span>
              <strong>{item.label}</strong>
            </div>
            <p>{item.detail}</p>
            <span className={`badge ${item.status}`}>{statusText(item.status)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
