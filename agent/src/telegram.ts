import type { Decision } from "./types.js";

function formatMnt(valueWei: bigint): string {
  return (Number(valueWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function formatAlert(decision: Decision, txHash?: `0x${string}`): string {
  const suffix = txHash ? `\nTx: ${txHash}` : "";
  if (decision.kind === "hold") {
    return `AI agent HOLD\nReason: ${decision.rationale}${suffix}`;
  }

  const side = decision.action === "sell" ? "SELL" : `BUY ${formatMnt(decision.valueWei)} MNT`;
  return `AI agent ${side}\nReason: ${decision.rationale}${suffix}`;
}

export async function sendAlert(decision: Decision, txHash?: `0x${string}`): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatAlert(decision, txHash) }),
    });
    if (!response.ok) {
      console.error("[telegram] send failed:", response.status, await response.text());
    }
  } catch (error) {
    console.error("[telegram] send failed:", error);
  }
}
