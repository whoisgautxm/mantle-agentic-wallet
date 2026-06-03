import type { SimulationFeed, SimulationFeedItem } from "../../lib/simulationFeed";

function formatTime(value: string | undefined): string {
  if (!value) return "not generated";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summaryStatus(items: readonly SimulationFeedItem[], error: string | undefined): SimulationFeedItem["status"] {
  if (error || items.some((item) => item.status === "bad")) return "bad";
  if (items.length && items.every((item) => item.status === "ok")) return "ok";
  return "warn";
}

function summaryLabel(status: SimulationFeedItem["status"], count: number): string {
  if (!count) return "No trace";
  if (status === "ok") return "Passing";
  if (status === "bad") return "Blocked";
  return "Watching";
}

function txHashLabel(txHash: string | undefined): string {
  if (!txHash) return "not submitted";
  if (txHash.length < 14) return txHash;
  return `${txHash.slice(0, 10)}...${txHash.slice(-6)}`;
}

export default function SimulationFeedPanel({ feed }: { feed: SimulationFeed }) {
  const status = summaryStatus(feed.items, feed.error);

  return (
    <section className="insight-card wide simulation-feed">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Execution preflight</p>
          <h2>Simulation feed</h2>
        </div>
        <span className={`badge ${status}`}>{summaryLabel(status, feed.items.length)}</span>
      </div>

      <p className="muted panel-note">
        Latest proposed transactions from JSONL traces, including simulation pass/fail, gas estimate, revert reason, and the rule
        that blocked execution.
      </p>

      {!feed.items.length ? (
        <article className="eval-card simulation-empty">
          <div className="eval-card-head">
            <div>
              <strong>{feed.error ? "Trace unavailable" : "No simulation records yet"}</strong>
              <span>{feed.artifactPath ?? "agent/traces/agent-events.jsonl"}</span>
            </div>
            <span className={`badge ${feed.error ? "bad" : "warn"}`}>{feed.error ? "Invalid" : "Empty"}</span>
          </div>
          <p>
            {feed.error ??
              "Run the demo loop or Merchant Moe fork-simulation command to populate proposed transaction preflights."}
          </p>
          <code>cd agent && npm run demo</code>
          <code>cd agent && npm run simulate:merchant-moe-fork</code>
        </article>
      ) : (
        <div className="eval-grid simulation-feed-grid">
          {feed.items.map((item) => (
            <article className="eval-card simulation-card" key={item.id}>
              <div className="eval-card-head">
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </div>
                <span className={`badge ${item.status}`}>{item.label}</span>
              </div>

              <p>{item.summary}</p>

              <div className="simulation-tx">
                <div>
                  <span>Target</span>
                  <strong>{item.target}</strong>
                </div>
                <div>
                  <span>Selector</span>
                  <strong>{item.selector}</strong>
                </div>
                <div>
                  <span>Action</span>
                  <strong>{item.action}</strong>
                </div>
                <div>
                  <span>Value wei</span>
                  <strong>{item.valueWei}</strong>
                </div>
              </div>

              <div className="eval-metrics simulation-metrics">
                {item.metrics.map((metric) => (
                  <div key={`${item.id}-${metric.label}`}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>

              <div className="simulation-blockers">
                <div>
                  <span>Revert reason</span>
                  <strong>{item.revertReason}</strong>
                </div>
                <div>
                  <span>Blocked execution reason</span>
                  <strong>{item.blockedRuleId ? `${item.blockedRuleId}: ${item.blockedReason}` : item.blockedReason}</strong>
                </div>
                <div>
                  <span>Tx hash</span>
                  <strong>{txHashLabel(item.txHash)}</strong>
                </div>
              </div>

              {item.findings.length ? (
                <div className="eval-findings">
                  {item.findings.map((finding) => (
                    <span key={finding}>{finding}</span>
                  ))}
                </div>
              ) : null}

              <div className="eval-footer">
                <span>{item.artifactPath ?? feed.artifactPath ?? "trace artifact not found"}</span>
                <span>{formatTime(item.updatedAt)}</span>
              </div>
              {item.command ? <code>{item.command}</code> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
