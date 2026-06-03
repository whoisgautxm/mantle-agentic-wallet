import type { LendingEvidence, LendingEvidenceItem } from "../../lib/lendingEvidence";

function formatTime(value: string | undefined): string {
  if (!value) return "not generated";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summaryStatus(items: readonly LendingEvidenceItem[]): LendingEvidenceItem["status"] {
  if (items.some((item) => item.status === "bad")) return "bad";
  if (items.every((item) => item.status === "ok")) return "ok";
  return "warn";
}

function summaryLabel(status: LendingEvidenceItem["status"]): string {
  if (status === "ok") return "Healthy";
  if (status === "bad") return "Blocked";
  return "Read-only";
}

export default function LendingReadinessPanel({ evidence }: { evidence: LendingEvidence }) {
  const status = summaryStatus(evidence.items);

  return (
    <section className="insight-card wide">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Lending risk</p>
          <h2>Health-factor readiness</h2>
        </div>
        <span className={`badge ${status}`}>{summaryLabel(status)}</span>
      </div>

      <div className="eval-grid protocol-evidence-grid">
        {evidence.items.map((item) => (
          <article className="eval-card protocol-evidence-card" key={item.id}>
            <div className="eval-card-head">
              <div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
              </div>
              <span className={`badge ${item.status}`}>{item.label}</span>
            </div>

            <p>{item.detail}</p>

            {item.metrics.length ? (
              <div className="eval-metrics lending-metrics">
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

            {item.nextSteps.length ? (
              <div className="eval-findings evidence-steps">
                {item.nextSteps.map((step) => (
                  <span key={step}>{step}</span>
                ))}
              </div>
            ) : null}

            <div className="eval-footer">
              <span>{item.artifactPath ?? "trace artifact not found"}</span>
              <span>{formatTime(item.updatedAt)}</span>
            </div>
            <code>{item.command}</code>
          </article>
        ))}
      </div>
    </section>
  );
}
