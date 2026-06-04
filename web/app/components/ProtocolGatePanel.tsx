import type { ProtocolGate, ProtocolGateStep } from "../../lib/protocolGate";

function formatTime(value: string | undefined): string {
  if (!value) return "not generated";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusIcon(status: ProtocolGateStep["status"]): string {
  if (status === "ok") return "PASS";
  if (status === "bad") return "STOP";
  return "WAIT";
}

export default function ProtocolGatePanel({ gate }: { gate: ProtocolGate }) {
  return (
    <section className="insight-card wide protocol-gate">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Real Protocol Gate</p>
          <h2>Merchant Moe readiness path</h2>
        </div>
        <span className={`badge ${gate.status}`}>{gate.label}</span>
      </div>

      <div className="gate-hero">
        <div>
          <strong>{gate.headline}</strong>
          <p>{gate.detail}</p>
        </div>
        <div>
          <span>Route</span>
          <strong>{gate.route}</strong>
        </div>
      </div>

      <div className="gate-rail" aria-label="Merchant Moe real protocol readiness steps">
        {gate.steps.map((step) => (
          <article className={`gate-step ${step.status}`} key={step.id}>
            <span>{statusIcon(step.status)}</span>
            <strong>{step.name}</strong>
            <em>{step.label}</em>
            <p>{step.detail}</p>
          </article>
        ))}
      </div>

      <div className="eval-metrics gate-metrics">
        {gate.metrics.map((metric) => (
          <div key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      <div className="gate-explainer">
        <div>
          <span>What this proves</span>
          <p>
            The agent is no longer just trading MockDEX. It is collecting real Merchant Moe quote evidence, checking an oracle
            reference, building router calldata in code, checking ERC20 state, and refusing to continue when a real DeFi
            prerequisite is missing.
          </p>
        </div>
        <div>
          <span>Current blocker</span>
          {gate.blockers.length ? (
            <div className="eval-findings gate-findings">
              {gate.blockers.map((blocker) => (
                <span key={blocker}>{blocker}</span>
              ))}
            </div>
          ) : (
            <p>No hard blocker captured in the latest Merchant Moe trace.</p>
          )}
        </div>
      </div>

      {gate.nextSteps.length ? (
        <div className="eval-findings evidence-steps">
          {gate.nextSteps.map((step) => (
            <span key={step}>{step}</span>
          ))}
        </div>
      ) : null}

      <div className="eval-footer">
        <span>{gate.artifactPath ?? "trace artifact not found"}</span>
        <span>{formatTime(gate.updatedAt)}</span>
      </div>
      <code>{gate.command}</code>
    </section>
  );
}
