import { getDecisions } from "../lib/events";

export const dynamic = "force-dynamic";

export default async function Page() {
  const decisions = await getDecisions();
  const explorer = "https://explorer.sepolia.mantle.xyz";
  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 820, margin: "40px auto", padding: 16 }}>
      <h1>🤖 Autonomous Agent Wallet — Live Decisions (Mantle)</h1>
      <p style={{ color: "#666" }}>
        Every action this AI agent takes is recorded on-chain. {decisions.length} decisions so far.
      </p>
      {decisions.map((d) => (
        <div key={d.nonce} style={{ border: "1px solid #eee", borderRadius: 12, padding: 16, marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>#{d.nonce} → {d.target}</div>
          <div>Value: {d.value} wei</div>
          <div style={{ marginTop: 8, fontStyle: "italic" }}>“{d.rationale}”</div>
          <a href={`${explorer}/tx/${d.txHash}`} target="_blank" rel="noreferrer">View on explorer ↗</a>
        </div>
      ))}
    </main>
  );
}
