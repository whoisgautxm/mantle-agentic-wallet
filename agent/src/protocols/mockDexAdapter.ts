import { encodeBuy, encodeSell } from "../dex.js";
import { buildExecutionProtection, loadExecutionProtectionFromEnv, type ExecutionProtectionConfig } from "./executionProtection.js";
import type { ProtocolAdapter, QuoteResult, TradeIntent } from "./types.js";

const BUY_SELECTOR = encodeBuy().slice(0, 10) as `0x${string}`;
const SELL_SELECTOR = encodeSell(1n).slice(0, 10) as `0x${string}`;
const NATIVE_ASSET = "0x0000000000000000000000000000000000000000" as const;

export function createMockDexAdapter(
  target: `0x${string}`,
  token: `0x${string}`,
  readPrice: () => Promise<bigint>,
  protection: ExecutionProtectionConfig = loadExecutionProtectionFromEnv(),
): ProtocolAdapter {
  return {
    id: "mockdex",
    mode: "execution",
    supportedActions: ["buy", "sell"],
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
        const executionProtection = buildExecutionProtection(quote.expectedTokenWei, protection);
        return {
          protocolId: "mockdex",
          action: "buy",
          target,
          valueWei,
          calldata: encodeBuy(),
          outputAsset: token,
          expectedOutWei: quote.expectedTokenWei,
          ...executionProtection,
          summary: `MockDEX buy with ${valueWei} wei MNT`,
        };
      }

      const amountTokenWei = intent.amountTokenWei ?? 0n;
      const executionProtection = buildExecutionProtection(quote.expectedMntWei, protection);
      return {
        protocolId: "mockdex",
        action: "sell",
        target,
        valueWei: 0n,
        calldata: encodeSell(amountTokenWei),
        outputAsset: NATIVE_ASSET,
        amountTokenWei,
        expectedOutWei: quote.expectedMntWei,
        ...executionProtection,
        summary: `MockDEX sell of ${amountTokenWei} token-wei`,
      };
    },
  };
}
