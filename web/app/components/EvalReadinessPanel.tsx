import type { EvalReadiness, EvalReadinessItem } from "../../lib/evalReadiness";

function statusText(status: EvalReadinessItem["status"]): string {
  if (status === "ok") return "Verified";
  if (status === "bad") return "Review";
  return "Pending";
}

function formatTime(value: string | undefined): string {
  if (!value) return "not generated";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EvalReadinessPanel({ readiness }: { readiness: EvalReadiness }) {
  const verified = readiness.items.filter((item) => item.status === "ok").length;

  return (
    <section className="insight-card wide">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Replay benchmark</p>
          <h2>Evals and trace evidence</h2>
        </div>
        <span className="badge ok">
          {verified}/{readiness.items.length} verified
        </span>
      </div>

      <div className="eval-grid">
        {readiness.items.map((item) => (
          <article className="eval-card" key={item.id}>
            <div className="eval-card-head">
              <div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
              </div>
              <span className={`badge ${item.status}`}>{statusText(item.status)}</span>
            </div>

            <p>{item.detail}</p>

            {item.metrics.length ? (
              <div className="eval-metrics">
                {item.metrics.map((metric) => (
                  <div key={`${item.id}-${metric.label}`}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            {item.findings.length ? (
              <div className="eval-findings">
                {item.findings.map((finding) => (
                  <span key={finding}>{finding}</span>
                ))}
              </div>
            ) : null}

            <div className="eval-footer">
              <span>{item.artifactPath ?? "artifact not found"}</span>
              <span>{formatTime(item.updatedAt)}</span>
            </div>
            <code>{item.command}</code>
          </article>
        ))}
      </div>
    </section>
  );
}
