import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildMerchantMoeForkReadinessReport,
  formatMerchantMoeForkReadiness,
  runMerchantMoeForkReadiness,
} from "./merchantMoeForkReadiness.js";
import { parseMerchantMoeQuoteSmokeConfig } from "./merchantMoeQuoteSmoke.js";
import type { MerchantMoeQuote } from "./protocols/merchantMoeReadOnlyAdapter.js";
import { createJsonlTraceWriter } from "./tracing.js";

const tokenA = "0x1111111111111111111111111111111111111111" as const;
const tokenB = "0x2222222222222222222222222222222222222222" as const;

const quote: MerchantMoeQuote = {
  protocolId: "merchant-moe",
  chainId: 5000,
  quoter: "0x501b8AFd35df20f531fF45F6f695793AC3316c85",
  router: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a",
  route: [tokenA, tokenB],
  pairs: ["0x3333333333333333333333333333333333333333"],
  binSteps: [25n],
  versions: [3],
  amounts: [1000n, 900n],
  virtualAmountsWithoutSlippage: [1000n, 930n],
  fees: [1n],
  amountIn: 1000n,
  amountOut: 900n,
};

describe("Merchant Moe fork readiness", () => {
  it("computes minOut and reports execution blockers", async () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
    });
    const report = await buildMerchantMoeForkReadinessReport(quote, config, {
      MERCHANT_MOE_SLIPPAGE_BPS: "100",
      MERCHANT_MOE_DEADLINE_SECONDS: "1200",
    });

    expect(report.ok).toBe(false);
    expect(report.minOutWei).toBe("891");
    expect(report.slippageBps).toBe("100");
    expect(report.deadlineSeconds).toBe("1200");
    expect(report.blockers.map((blocker) => blocker.ruleId)).toEqual([
      "FORK_RPC_MISSING",
      "EXECUTION_CALLDATA_DISABLED",
    ]);
  });

  it("includes quote deviation blockers", async () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
      MERCHANT_MOE_REFERENCE_PRICE_WEI: "1000000000000000000",
      MERCHANT_MOE_MAX_DEVIATION_BPS: "1",
    });
    const report = await buildMerchantMoeForkReadinessReport(quote, config, {
      MANTLE_MAINNET_FORK_RPC_URL: "http://127.0.0.1:8545",
    });

    expect(report.blockers.map((blocker) => blocker.ruleId)).toContain("DEX_ORACLE_DEVIATION");
    expect(report.blockers.map((blocker) => blocker.ruleId)).not.toContain("FORK_RPC_MISSING");
  });

  it("formats a no-execution readiness report", async () => {
    const config = parseMerchantMoeQuoteSmokeConfig({
      MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
      MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
    });
    const report = await buildMerchantMoeForkReadinessReport(quote, config, {});
    const output = formatMerchantMoeForkReadiness(report);

    expect(output).toContain("[merchant-moe] mainnet-fork readiness");
    expect(output).toContain("EXECUTION_CALLDATA_DISABLED");
    expect(output).toContain("execution: disabled");
  });

  it("runs with an injected read-only adapter and writes trace output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "merchant-moe-readiness-"));
    const trace = createJsonlTraceWriter({ path: path.join(dir, "events.jsonl") });
    const writes: string[] = [];
    const adapter = {
      async quoteExactInput() {
        return quote;
      },
    };

    const report = await runMerchantMoeForkReadiness(
      adapter,
      {
        MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
        MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
      },
      (message) => writes.push(message),
      trace,
    );

    const [event] = (await readFile(trace.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(report.executionEnabled).toBe(false);
    expect(writes[0]).toContain("mainnet-fork readiness");
    expect(event.type).toBe("merchant_moe.fork_readiness");
    expect(event.report.executionEnabled).toBe(false);
  });
});
