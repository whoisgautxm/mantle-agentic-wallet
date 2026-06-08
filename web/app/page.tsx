import { getDecisions, getPriceHistory, getTrades } from "../lib/events";
import { getChainReplaySnapshot } from "../lib/chainReplaySnapshot";
import { buildSeries, currentStanding } from "../lib/pnl";
import AutoRefresh from "./components/AutoRefresh";
import PriceChart from "./components/PriceChart";
import DecisionFeed from "./components/DecisionFeed";
import LendingReadinessPanel from "./components/LendingReadinessPanel";
import OraclePanel from "./components/OraclePanel";
import PortfolioPanel from "./components/PortfolioPanel";
import ProtocolEvidencePanel from "./components/ProtocolEvidencePanel";
import ProtocolGatePanel from "./components/ProtocolGatePanel";
import ProtocolReadinessPanel from "./components/ProtocolReadinessPanel";
import RiskPanel from "./components/RiskPanel";
import SimulationFeedPanel from "./components/SimulationFeedPanel";
import EvalReadinessPanel from "./components/EvalReadinessPanel";
import addresses from "../../shared/addresses.json";
import { getEvalReadiness } from "../lib/evalReadiness";
import { getLendingEvidence } from "../lib/lendingEvidence";
import { getPortfolioStatus } from "../lib/portfolio";
import { getProtocolEvidence } from "../lib/protocolEvidence";
import { getProtocolGate } from "../lib/protocolGate";
import { getProtocolReadiness } from "../lib/protocolReadiness";
import { getSimulationFeed } from "../lib/simulationFeed";
import { getLiveStatus } from "../lib/status";
import { getTraceReplay } from "../lib/traceReplay";

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

function compactIso(value: string | undefined): string {
  if (!value) return "unknown";
  return value.replace("T", " ").slice(0, 16) + " UTC";
}

async function safeRead<T>(label: string, read: () => Promise<T>, fallback: T): Promise<{ value: T; warning?: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    const e = error as any;
    return { value: fallback, warning: `${label}: ${e?.shortMessage ?? e?.message ?? "unavailable"}` };
  }
}

export default async function Page() {
  const aiVault = ((addresses as any).aiVault ?? addresses.agentVault) as `0x${string}`;
  const baselineVault = (addresses as any).baselineVault as `0x${string}`;

  const requestedReplaySource = (process.env.CHAIN_REPLAY_SOURCE ?? "trace").toLowerCase();
  const liveRequested = requestedReplaySource === "live";
  const snapshotRequested = requestedReplaySource === "snapshot";
  const traceRequested = !liveRequested && !snapshotRequested;
  const traceReplay = await getTraceReplay();
  const liveReplay = liveRequested
    ? await Promise.all([
        safeRead("AI decisions", () => getDecisions(aiVault), []),
        safeRead("baseline decisions", () => getDecisions(baselineVault), []),
        safeRead("price history", getPriceHistory, []),
        safeRead("trade history", getTrades, []),
      ])
    : undefined;
  const aiDecisionsResult = liveReplay?.[0] ?? { value: [] };
  const baselineDecisionsResult = liveReplay?.[1] ?? { value: [] };
  const pricesResult = liveReplay?.[2] ?? { value: [] };
  const tradesResult = liveReplay?.[3] ?? { value: [] };
  const eventWarnings = [aiDecisionsResult, baselineDecisionsResult, pricesResult, tradesResult]
    .map((result) => result.warning)
    .filter(Boolean);
  const replaySnapshot = getChainReplaySnapshot();
  const usingTrace = traceRequested && traceReplay.available;
  const usingSnapshot = !usingTrace && (snapshotRequested || !liveRequested || eventWarnings.length > 0);
  const aiDecisions = usingTrace ? traceReplay.aiDecisions : usingSnapshot ? replaySnapshot.aiDecisions : aiDecisionsResult.value;
  const baselineDecisions = usingTrace
    ? traceReplay.baselineDecisions
    : usingSnapshot
      ? replaySnapshot.baselineDecisions
      : baselineDecisionsResult.value;
  const prices = usingSnapshot ? replaySnapshot.prices : usingTrace ? [] : pricesResult.value;
  const trades = usingSnapshot ? replaySnapshot.trades : usingTrace ? [] : tradesResult.value;
  const liveStatus = await getLiveStatus();
  const portfolioStatus = await getPortfolioStatus([
    { name: "AI", address: aiVault },
    { name: "Baseline", address: baselineVault },
  ]);
  const protocolReadiness = getProtocolReadiness(liveStatus, portfolioStatus);
  const protocolEvidence = await getProtocolEvidence();
  const protocolGate = await getProtocolGate();
  const simulationFeed = await getSimulationFeed();
  const lendingEvidence = await getLendingEvidence();
  const evalReadiness = await getEvalReadiness();
  const series = usingTrace
    ? traceReplay.series
    : buildSeries(prices, trades, aiVault, baselineVault, usingSnapshot ? replaySnapshot.opening : undefined);
  const openingPrice = prices[0]?.price ?? 0n;
  const snapshotStarts = usingSnapshot
    ? {
        aiPortfolioWei: replaySnapshot.opening.aiMntWei + (replaySnapshot.opening.aiTokenWei * openingPrice) / 10n ** 18n,
        baselinePortfolioWei:
          replaySnapshot.opening.baselineMntWei + (replaySnapshot.opening.baselineTokenWei * openingPrice) / 10n ** 18n,
      }
    : undefined;
  const standing = currentStanding(series, usingTrace ? traceReplay.starts : snapshotStarts);

  // Run provenance (live-run report section 13): never present a stale snapshot as the live leader.
  const dex = (addresses as any).mockDex as string;
  const deployBlock = (addresses as any).deployBlock ?? "?";
  const dataSourceLabel = usingTrace ? "Agent trace" : usingSnapshot ? "Tracked snapshot" : "Live on-chain";
  const dataSourceBadge = usingTrace ? "TRACE" : usingSnapshot ? "SNAPSHOT" : "LIVE";
  const dataSourceDetail = usingTrace
    ? `JSONL replay from ${traceReplay.artifactPath ?? "agent trace"}, updated ${compactIso(traceReplay.updatedAt)}`
    : usingSnapshot
      ? `${replaySnapshot.source}, captured ${compactIso(replaySnapshot.generatedAt)}`
      : "live RPC reads";
  const blockRange = usingTrace
    ? `${traceReplay.eventCount} events · ${traceReplay.finalActionCount} final actions`
    : usingSnapshot
      ? `${replaySnapshot.fromBlock}-${replaySnapshot.toBlock}`
      : prices.length
        ? `${prices[0].block.toString()}-${prices[prices.length - 1].block.toString()}`
        : "n/a";
  const standingSource = usingTrace ? "agent JSONL trace" : usingSnapshot ? "tracked snapshot — not a live run" : "live on-chain run";
  const activityPrimary = usingTrace ? `${aiDecisions.length + baselineDecisions.length} actions` : `${trades.length} trades`;
  const activitySecondary = usingTrace ? `${series.length} trace points` : `${prices.length} price points`;

  return (
    <main>
      <AutoRefresh />
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

      <section className="insights single">
        <section className="insight-card">
          <div className="section-head compact">
            <div>
              <p className="eyebrow">Run provenance</p>
              <h2>{dataSourceLabel} · accounting: vault-only ROI</h2>
            </div>
            <span className={`badge ${usingSnapshot ? "warn" : "ok"}`}>{dataSourceBadge}</span>
          </div>
          <div className="eval-findings">
            <span>
              Deployment — AI {short(aiVault)} · Baseline {short(baselineVault)} · DEX {short(dex)} · deploy block {deployBlock}
            </span>
            <span>
              Data source: {dataSourceDetail}. Block range {blockRange}.
            </span>
            <span>
              The standing below reflects the {standingSource}. ROI is vault-only and excludes runner gas; gas-adjusted ROI is
              recorded per decision in the agent trace.
            </span>
            {traceRequested && !usingTrace && traceReplay.error ? <span>Trace replay fallback: {traceReplay.error}</span> : null}
            {eventWarnings.map((warning) => (
              <span key={warning}>Live RPC fallback: {warning}</span>
            ))}
          </div>
        </section>
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
          <strong>{activityPrimary}</strong>
          <span>{activitySecondary}</span>
        </div>
      </section>

      <section className="insights">
        <OraclePanel status={liveStatus} />
        <RiskPanel status={liveStatus} />
      </section>

      <section className="insights single">
        <ProtocolReadinessPanel readiness={protocolReadiness} />
      </section>

      <section className="insights single">
        <ProtocolEvidencePanel evidence={protocolEvidence} />
      </section>

      <section className="insights single">
        <ProtocolGatePanel gate={protocolGate} />
      </section>

      <section className="insights single">
        <SimulationFeedPanel feed={simulationFeed} />
      </section>

      <section className="insights single">
        <PortfolioPanel status={portfolioStatus} />
      </section>

      <section className="insights single">
        <LendingReadinessPanel evidence={lendingEvidence} />
      </section>

      <section className="insights single">
        <EvalReadinessPanel readiness={evalReadiness} />
      </section>

      {usingSnapshot ? (
        <section className="insights single">
          <section className="insight-card">
            <div className="section-head compact">
              <div>
                <p className="eyebrow">Chain replay</p>
                <h2>Verified event snapshot</h2>
              </div>
              <span className="badge ok">Chain-derived</span>
            </div>
            <p className="muted panel-note">
              {eventWarnings.length
                ? "The live RPC rejected the historical log query, so "
                : "The dashboard is configured for fast snapshot replay, so "}
              the chart and feeds use a tracked Mantle Sepolia event snapshot from blocks {replaySnapshot.fromBlock} to{" "}
              {replaySnapshot.toBlock}. Transaction links remain independently verifiable on the explorer.
            </p>
            <div className="eval-findings">
              <span>
                Captured {replaySnapshot.prices.length} prices, {replaySnapshot.trades.length} trades,{" "}
                {replaySnapshot.aiDecisions.length} AI decisions, and {replaySnapshot.baselineDecisions.length} baseline decisions.
              </span>
              <span>
                Generated {new Date(replaySnapshot.generatedAt).toLocaleString()} from {replaySnapshot.source}.
              </span>
            </div>
          </section>
        </section>
      ) : null}

      {usingTrace ? (
        <section className="insights single">
          <section className="insight-card">
            <div className="section-head compact">
              <div>
                <p className="eyebrow">JSONL replay</p>
                <h2>Live agent trace source</h2>
              </div>
              <span className="badge ok">Refreshes</span>
            </div>
            <p className="muted panel-note">
              The chart and feeds are reading the current agent trace. While the demo loop is running, this file grows every tick and
              the page refreshes every 15 seconds without a hydration-prone meta tag.
            </p>
            <div className="eval-findings">
              <span>
                Parsed {traceReplay.eventCount} trace events and {traceReplay.finalActionCount} final actions from{" "}
                {traceReplay.artifactPath}.
              </span>
              <span>Last file update: {compactIso(traceReplay.updatedAt)}.</span>
            </div>
          </section>
        </section>
      ) : null}

      <section className="chart-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">{usingTrace ? "Agent trace replay" : "On-chain replay"}</p>
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
