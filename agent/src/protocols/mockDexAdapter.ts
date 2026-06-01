import { encodeBuy, encodeSell } from "../dex.js";
import type { ProtocolAdapter, QuoteResult, TradeIntent } from "./types.js";

const BUY_SELECTOR = encodeBuy().slice(0, 10) as `0x${string}`;
const SELL_SELECTOR = encodeSell(1n).slice(0, 10) as `0x${string}`;

export function createMockDexAdapter(target: `0x${string}`, readPrice: () => Promise<bigint>): ProtocolAdapter {
  return {
    id: "mockdex",
    target,
    allowedSelectors: [BUY_SELECTOR, SELL_SELECTOR],
    async quote(intent: TradeIntent): Promise<QuoteResult> {
      const priceWei = await readPrice();
      if (intent.action === "buy") {
        const expectedTokenWei =
          intent.amountMntWei === undefined ? undefined : (intent.amountMntWei * 10n ** 18n) / priceWei;
        return { protocolId: "mockdex", priceWei, expectedTokenWei };
      }
      const expectedMntWei =
        intent.amountTokenWei === undefined ? undefined : (intent.amountTokenWei * priceWei) / 10n ** 18n;
      return { protocolId: "mockdex", priceWei, expectedMntWei };
    },
    buildPlan(intent: TradeIntent, quote: QuoteResult) {
      if (intent.action === "buy") {
        const valueWei = intent.amountMntWei ?? 0n;
        return {
          protocolId: "mockdex",
          action: "buy",
          target,
          valueWei,
          calldata: encodeBuy(),
          expectedOutWei: quote.expectedTokenWei,
          summary: `MockDEX buy with ${valueWei} wei MNT`,
        };
      }

      const amountTokenWei = intent.amountTokenWei ?? 0n;
      return {
        protocolId: "mockdex",
        action: "sell",
        target,
        valueWei: 0n,
        calldata: encodeSell(amountTokenWei),
        amountTokenWei,
        expectedOutWei: quote.expectedMntWei,
        summary: `MockDEX sell of ${amountTokenWei} token-wei`,
      };
    },
  };
}
