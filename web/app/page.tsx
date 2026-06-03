import { getDecisions, getPriceHistory, getTrades } from "../lib/events";
import { buildSeries, currentStanding } from "../lib/pnl";
import PriceChart from "./components/PriceChart";
import DecisionFeed from "./components/DecisionFeed";
import OraclePanel from "./components/OraclePanel";
import RiskPanel from "./components/RiskPanel";
import addresses from "../../shared/addresses.json";
import { getLiveStatus } from "../lib/status";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const explorer = "https://explorer.sepolia.mantle.xyz";

function short(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function mnt(wei: bigint): string {
  return `${(Number(wei) / 1e18).toFixed(5)} MNT`;
}

function pct(bps: bigint): string {
  const v = Number(bps) / 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export default async function Page() {
  const aiVault = ((addresses as any).aiVault ?? addresses.agentVault) as `0x${string}`;
  const baselineVault = (addresses as any).baselineVault as `0x${string}`;

  const aiDecisions = await getDecisions(aiVault);
  const baselineDecisions = await getDecisions(baselineVault);
  const prices = await getPriceHistory();
  const trades = await getTrades();
  const liveStatus = await getLiveStatus();
  const series = buildSeries(prices, trades, aiVault, baselineVault);
  const standing = currentStanding(series);

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
          <span>AI Portfolio</span>
          <strong>{mnt(standing.aiPortfolioWei)}</strong>
          <span>{pct(standing.aiRoiBps)} ROI</span>
        </div>
        <div>
          <span>Baseline Portfolio</span>
          <strong>{mnt(standing.baselinePortfolioWei)}</strong>
          <span>{pct(standing.baselineRoiBps)} ROI</span>
        </div>
        <div>
          <span>Leader</span>
          <strong>{standing.leader}</strong>
          <span>{pct(standing.edgeBps)} AI vs baseline</span>
        </div>
        <div>
          <span>Activity</span>
          <strong>{trades.length} trades</strong>
          <span>{prices.length} price points</span>
        </div>
      </section>

      <section className="insights">
        <OraclePanel status={liveStatus} />
        <RiskPanel status={liveStatus} />
      </section>

      <section className="chart-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">On-chain replay</p>
            <h2>Price and total-portfolio timeline</h2>
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
