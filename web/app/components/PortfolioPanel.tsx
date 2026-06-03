import { formatTokenAmount, type PortfolioStatus } from "../../lib/portfolio";

function statusLabel(status: string): string {
  if (status === "unbounded") return "Unbounded";
  if (status === "excessive") return "Excessive";
  if (status === "bounded") return "Bounded";
  return "None";
}

export default function PortfolioPanel({ status }: { status: PortfolioStatus }) {
  if (status.ok === false) {
    return (
      <section className="insight-card wide">
        <p className="eyebrow">Portfolio and allowances</p>
        <h2>Unavailable</h2>
        <p className="muted">{status.reason}</p>
      </section>
    );
  }

  if (!status.configured) {
    return (
      <section className="insight-card wide">
        <p className="eyebrow">Portfolio and allowances</p>
        <h2>Ready for ERC20 tracking</h2>
        <p className="muted panel-note">
          Configure PORTFOLIO_TOKENS and PORTFOLIO_SPENDERS to track real Mantle token balances and router allowances before enabling real DEX adapters.
        </p>
      </section>
    );
  }

  return (
    <section className="insight-card wide">
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Portfolio and allowances</p>
          <h2>ERC20 exposure watch</h2>
        </div>
        <span className="badge ok">{status.tokens.length} tokens</span>
      </div>

      <div className="portfolio-table">
        <div className="table-head">
          <span>Vault</span>
          <span>Token</span>
          <span>Balance</span>
          <span>Risk tier</span>
        </div>
        {status.balances.map((row) => (
          <div className="table-row" key={`${row.vault}-${row.token.address}`}>
            <span>{row.vaultName}</span>
            <strong>{row.token.symbol}</strong>
            <span>{formatTokenAmount(row.balanceRaw, row.token)}</span>
            <span>{row.token.riskTier}</span>
          </div>
        ))}
      </div>

      {status.allowances.length > 0 ? (
        <div className="portfolio-table allowance-table">
          <div className="table-head">
            <span>Vault</span>
            <span>Token</span>
            <span>Spender</span>
            <span>Status</span>
          </div>
          {status.allowances.map((row) => (
            <div className="table-row" key={`${row.vault}-${row.token.address}-${row.spender.address}`}>
              <span>{row.vaultName}</span>
              <strong>{row.token.symbol}</strong>
              <span>{row.spender.name}</span>
              <span className={`badge ${row.unsafe ? "bad" : row.status === "none" ? "warn" : "ok"}`}>
                {statusLabel(row.status)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted panel-note">No spenders configured yet, so allowance checks are not active.</p>
      )}
    </section>
  );
}
