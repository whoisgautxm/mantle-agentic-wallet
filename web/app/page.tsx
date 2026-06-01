import { getDecisions, getPriceHistory, getTrades } from "../lib/events";
import { buildSeries } from "../lib/pnl";
import PriceChart from "./components/PriceChart";
import DecisionFeed from "./components/DecisionFeed";
import addresses from "../../shared/addresses.json";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const explorer = "https://explorer.sepolia.mantle.xyz";

function short(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default async function Page() {
  const aiVault = ((addresses as any).aiVault ?? addresses.agentVault) as `0x${string}`;
  const baselineVault = (addresses as any).baselineVault as `0x${string}`;

  const aiDecisions = await getDecisions(aiVault);
  const baselineDecisions = await getDecisions(baselineVault);
  const prices = await getPriceHistory();
  const trades = await getTrades();
  const series = buildSeries(prices, trades, aiVault, baselineVault);
  const last = series[series.length - 1];

  return (
    <main>
      <meta httpEquiv="refresh" content="15" />
      <section className="hero">
        <div>
          <p className="eyebrow">Mantle Turing Test Demo</p>
          <h1>Human vs AI trading wallet</h1>
          <p className="lede">
            An OpenAI-powered trader runs through a guarded vault while a deterministic DCA baseline runs beside it. Every action,
            price update, and trade is reconstructed from on-chain events.
          </p>
        </div>
        <div className="status-card">
          <span>AI Vault</span>
          <strong>{short(aiVault)}</strong>
          <span>Baseline</span>
          <strong>{short(baselineVault)}</strong>
        </div>
      </section>

      <section className="stats">
        <div>
          <span>Price Points</span>
          <strong>{prices.length}</strong>
        </div>
        <div>
          <span>Trades</span>
          <strong>{trades.length}</strong>
        </div>
        <div>
          <span>AI Token Value</span>
          <strong>{last ? (Number(BigInt(last.aiTokenValueWei)) / 1e18).toFixed(5) : "0.00000"} MNT</strong>
        </div>
        <div>
          <span>Baseline Token Value</span>
          <strong>{last ? (Number(BigInt(last.baselineTokenValueWei)) / 1e18).toFixed(5) : "0.00000"} MNT</strong>
        </div>
      </section>

      <section className="chart-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">On-chain replay</p>
            <h2>Price and token-value timeline</h2>
          </div>
          <span>Auto-refreshes every 15s</span>
        </div>
        <PriceChart data={series} />
      </section>

      <section className="feeds">
        <DecisionFeed title="AI Agent" decisions={aiDecisions} explorer={explorer} accent="#55d08a" />
        <DecisionFeed title="Human Baseline" decisions={baselineDecisions} explorer={explorer} accent="#72a8ff" />
      </section>
    </main>
  );
}
