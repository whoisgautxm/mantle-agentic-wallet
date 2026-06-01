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
    AI: fromWei(point.aiPortfolioWei),
    Baseline: fromWei(point.baselinePortfolioWei),
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
        {/* Left axis: portfolio value (MNT). Right axis: market price (MNT/token). */}
        <YAxis
          yAxisId="value"
          domain={["auto", "auto"]}
          tick={{ fill: "#b8ad95", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(v: number) => `${v.toFixed(3)}`}
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          domain={["auto", "auto"]}
          tick={{ fill: "#8c8470", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => `${v.toFixed(2)}`}
        />
        <Tooltip
          contentStyle={{
            background: "#19150f",
            border: "1px solid rgba(232,185,104,0.35)",
            borderRadius: 14,
            color: "#fff7e7",
          }}
          formatter={(value: number, name: string) =>
            name === "Price" ? [`${value.toFixed(4)} MNT/token`, name] : [`${value.toFixed(5)} MNT`, name]
          }
        />
        <Legend wrapperStyle={{ color: "#d9caa8" }} />
        <Line
          yAxisId="value"
          type="monotone"
          dataKey="AI"
          stroke="#55d08a"
          strokeWidth={3}
          dot={false}
          name="AI portfolio"
        />
        <Line
          yAxisId="value"
          type="monotone"
          dataKey="Baseline"
          stroke="#72a8ff"
          strokeWidth={3}
          dot={false}
          name="Baseline portfolio"
        />
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="price"
          stroke="#d8a447"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          name="Price"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
