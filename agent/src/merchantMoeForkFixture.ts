import "dotenv/config";
import { pathToFileURL } from "url";
import {
  buildMerchantMoeForkSimulationReport,
  formatMerchantMoeForkSimulation,
  loadMerchantMoeForkSimulationConfig,
  type ForkSimulationClient,
  type MerchantMoeForkSimulationReport,
} from "./merchantMoeForkSimulation.js";
import { buildMerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import { quoteTokenInPerTokenOutPriceWei, type MerchantMoeQuoteSmokeConfig } from "./merchantMoeQuoteSmoke.js";
import { MERCHANT_MOE_MANTLE, type MerchantMoeQuote } from "./protocols/merchantMoeReadOnlyAdapter.js";
import { MERCHANT_MOE_TOKENS } from "./protocols/merchantMoeRoutePresets.js";
import { createJsonlTraceWriter, type JsonlTraceWriter } from "./tracing.js";

const fixtureOwner = "0x3333333333333333333333333333333333333333" as const;
const fixturePair = "0x4444444444444444444444444444444444444444" as const;
const amountIn = 100_000_000_000_000_000n;
const amountOut = 55_155n;

export function buildMerchantMoeFixtureQuote(): MerchantMoeQuote {
  return {
    protocolId: "merchant-moe",
    chainId: MERCHANT_MOE_MANTLE.chainId,
    quoter: MERCHANT_MOE_MANTLE.lbQuoter,
    router: MERCHANT_MOE_MANTLE.lbRouter,
    route: [MERCHANT_MOE_TOKENS.WMNT.address, MERCHANT_MOE_TOKENS.USDC.address],
    pairs: [fixturePair],
    binSteps: [25n],
    versions: [3],
    amounts: [amountIn, amountOut],
    virtualAmountsWithoutSlippage: [amountIn, 55_400n],
    fees: [12n],
    amountIn,
    amountOut,
  };
}

export function buildMerchantMoeFixtureQuoteConfig(quote = buildMerchantMoeFixtureQuote()): MerchantMoeQuoteSmokeConfig {
  const config: MerchantMoeQuoteSmokeConfig = {
    routePresetId: "wmnt-usdc-direct",
    route: quote.route,
    amountIn: quote.amountIn,
    tokenInDecimals: MERCHANT_MOE_TOKENS.WMNT.decimals,
    tokenOutDecimals: MERCHANT_MOE_TOKENS.USDC.decimals,
    maxDeviationBps: 500n,
    referenceSource: "manual",
    referencePriceWei: 1n,
  };
  config.referencePriceWei = quoteTokenInPerTokenOutPriceWei(quote, config);
  return config;
}

export function createMerchantMoeFixtureClient(quote = buildMerchantMoeFixtureQuote()): ForkSimulationClient {
  return {
    async readContract(args) {
      const functionName = (args as { functionName?: string }).functionName;
      if (functionName === "balanceOf") return quote.amountIn * 2n;
      if (functionName === "allowance") return quote.amountIn;
      throw new Error(`unexpected fixture readContract function ${functionName}`);
    },
    async call() {
      return { data: "0x01" };
    },
    async estimateGas() {
      return 184_000n;
    },
  };
}

export async function runMerchantMoeForkFixture(
  write: (message: string) => void = console.log,
  trace: JsonlTraceWriter = createJsonlTraceWriter({ env: process.env }),
): Promise<MerchantMoeForkSimulationReport> {
  const quote = buildMerchantMoeFixtureQuote();
  const quoteConfig = buildMerchantMoeFixtureQuoteConfig(quote);
  const env = {
    MERCHANT_MOE_SLIPPAGE_BPS: "100",
    MERCHANT_MOE_DEADLINE_SECONDS: "1200",
    MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
    MERCHANT_MOE_FORK_RPC_URL: "fixture://merchant-moe",
  };
  const readiness = await buildMerchantMoeForkReadinessReport(quote, quoteConfig, env);
  const simulationConfig = {
    ...loadMerchantMoeForkSimulationConfig({
      MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
      MERCHANT_MOE_FORK_RPC_URL: "fixture://merchant-moe",
      MERCHANT_MOE_SIMULATION_FROM: fixtureOwner,
      MERCHANT_MOE_LB_ROUTER: MERCHANT_MOE_MANTLE.lbRouter,
      MERCHANT_MOE_SIMULATION_RATIONALE: "Merchant Moe controlled fork fixture",
    }),
    fixtureMode: true,
  };
  const report = await buildMerchantMoeForkSimulationReport(readiness, simulationConfig, createMerchantMoeFixtureClient(quote), quote);
  write(formatMerchantMoeForkSimulation(report));
  try {
    await trace.append("merchant_moe.fork_simulation", {
      protocolId: report.protocolId,
      mode: report.mode,
      fixtureMode: report.fixtureMode,
      report,
    });
  } catch (error) {
    const e = error as any;
    console.warn("[merchant-moe] fork fixture trace write failed:", e?.message ?? "unknown error");
  }
  return report;
}

export async function main(): Promise<void> {
  const report = await runMerchantMoeForkFixture();
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const e = error as any;
    console.error(`[merchant-moe] fork fixture failed: ${e?.shortMessage ?? e?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
