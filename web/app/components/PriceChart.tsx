"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

import type { SeriesPoint } from "../../lib/pnl";

function fromWei(value: string): number {
  return Number(BigInt(value)) / 1e18;
}

export default function PriceChart({ data }: { data: SeriesPoint[] }) {
  const rows = data.map((point) => ({
    block: point.block,
    price: fromWei(point.priceWei),
    AI: fromWei(point.aiTokenValueWei),
    Baseline: fromWei(point.baselineTokenValueWei),
  }));

  if (rows.length === 0) {
    return (
      <div className="empty-chart">
        Deploy the contracts and start the keeper to populate the on-chain price/PnL chart.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={rows} margin={{ top: 8, right: 20, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="2 6" stroke="rgba(246,239,220,0.16)" />
        <XAxis dataKey="block" tick={{ fill: "#b8ad95", fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: "#b8ad95", fontSize: 11 }} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: "#19150f",
            border: "1px solid rgba(232,185,104,0.35)",
            borderRadius: 14,
            color: "#fff7e7",
          }}
        />
        <Legend wrapperStyle={{ color: "#d9caa8" }} />
        <Line type="monotone" dataKey="price" stroke="#d8a447" strokeWidth={2} dot={false} name="Price" />
        <Line type="monotone" dataKey="AI" stroke="#55d08a" strokeWidth={3} dot={false} name="AI token value" />
        <Line
          type="monotone"
          dataKey="Baseline"
          stroke="#72a8ff"
          strokeWidth={3}
          dot={false}
          name="Baseline token value"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
