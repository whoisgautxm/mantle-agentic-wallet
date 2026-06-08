import type { DecisionLog } from "../../lib/events";

function formatMnt(valueWei: string): string {
  const value = Number(BigInt(valueWei)) / 1e18;
  return value.toLocaleString(undefined, { maximumFractionDigits: 5 });
}

function outcomeLabel(decision: DecisionLog): string {
  return decision.outcome ?? (decision.txHash ? "executed" : "recorded");
}

export default function DecisionFeed({
  title,
  decisions,
  explorer,
  accent,
}: {
  title: string;
  decisions: DecisionLog[];
  explorer: string;
  accent: string;
}) {
  return (
    <section className="feed-card">
      <div className="feed-head">
        <h2>{title}</h2>
        <span style={{ color: accent }}>{decisions.length} decisions</span>
      </div>
      {decisions.length === 0 ? (
        <p className="muted">No on-chain decisions yet. Once the runner submits, this feed becomes the replay tape.</p>
      ) : (
        decisions.map((decision) => (
          <article key={`${decision.source ?? "chain"}-${decision.txHash || decision.timestamp || decision.block}-${decision.nonce}`} className="decision">
            <div className="decision-top">
              <strong>#{decision.nonce}</strong>
              <span>{formatMnt(decision.value)} MNT</span>
            </div>
            <div className="decision-meta">
              <span className="badge warn">{outcomeLabel(decision)}</span>
              <span>{decision.timestamp ? decision.timestamp.replace("T", " ").slice(0, 19) : `block ${decision.block}`}</span>
            </div>
            <p>{decision.rationale}</p>
            {decision.txHash ? (
              <a href={`${explorer}/tx/${decision.txHash}`} target="_blank" rel="noreferrer" style={{ color: accent }}>
                View tx
              </a>
            ) : (
              <span className="muted">No tx submitted</span>
            )}
          </article>
        ))
      )}
    </section>
  );
}
