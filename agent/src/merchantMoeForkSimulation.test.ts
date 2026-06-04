import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildMerchantMoeForkSimulationReport,
  formatMerchantMoeForkSimulation,
  loadMerchantMoeForkSimulationConfig,
  runMerchantMoeForkSimulation,
  type ForkSimulationClient,
} from "./merchantMoeForkSimulation.js";
import { buildMerchantMoeForkReadinessReport } from "./merchantMoeForkReadiness.js";
import { parseMerchantMoeQuoteSmokeConfig } from "./merchantMoeQuoteSmoke.js";
import { LB_ROUTER_SWAP_ABI } from "./protocols/merchantMoeCalldata.js";
import type { MerchantMoeQuote } from "./protocols/merchantMoeReadOnlyAdapter.js";
import { createJsonlTraceWriter } from "./tracing.js";

const tokenA = "0x1111111111111111111111111111111111111111" as const;
const tokenB = "0x2222222222222222222222222222222222222222" as const;
const router = "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a" as const;
const from = "0x3333333333333333333333333333333333333333" as const;

const quote: MerchantMoeQuote = {
  protocolId: "merchant-moe",
  chainId: 5000,
  quoter: "0x501b8AFd35df20f531fF45F6f695793AC3316c85",
  router,
  route: [tokenA, tokenB],
  pairs: ["0x4444444444444444444444444444444444444444"],
  binSteps: [25n],
  versions: [3],
  amounts: [1000n, 900n],
  virtualAmountsWithoutSlippage: [1000n, 930n],
  fees: [1n],
  amountIn: 1000n,
  amountOut: 900n,
};

async function readiness(env: NodeJS.ProcessEnv = {}) {
  const config = parseMerchantMoeQuoteSmokeConfig({
    MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
    MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
    ...env,
  });
  return buildMerchantMoeForkReadinessReport(quote, config, env);
}

describe("Merchant Moe fork simulation", () => {
  it("reports blocked preconditions before attempting simulation", async () => {
    const report = await buildMerchantMoeForkSimulationReport(await readiness(), loadMerchantMoeForkSimulationConfig({}));

    expect(report.ok).toBe(false);
    expect(report.simulationAttempted).toBe(false);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual([
      "FORK_RPC_MISSING",
      "FORK_SIMULATION_DISABLED",
      "SIMULATION_FROM_MISSING",
      "CALLDATA_MISSING",
      "LIVE_EXECUTION_DISABLED",
    ]);
  });

  it("simulates router calldata on an injected fork client", async () => {
    const calls: unknown[] = [];
    const client: ForkSimulationClient = {
      async call(args) {
        calls.push(args);
        return { data: "0x1234" };
      },
      async estimateGas() {
        return 12_345n;
      },
    };

    const report = await buildMerchantMoeForkSimulationReport(
      await readiness(),
      loadMerchantMoeForkSimulationConfig({
        MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
        MERCHANT_MOE_FORK_RPC_URL: "http://127.0.0.1:8545",
        MERCHANT_MOE_SIMULATION_FROM: from,
        MERCHANT_MOE_SWAP_CALLDATA: "0xabcdef12",
      }),
      client,
    );

    expect(report.ok).toBe(true);
    expect(report.simulationAttempted).toBe(true);
    expect(report.simulationPassed).toBe(true);
    expect(report.simulation?.gasEstimate).toBe(12_345n);
    expect(report.target).toBe(router);
    expect(report.calldataSource).toBe("env");
    expect(calls).toHaveLength(1);
  });

  it("auto-builds fork-only LBRouter calldata from quote metadata", async () => {
    const calls: unknown[] = [];
    const client: ForkSimulationClient = {
      async call(args) {
        calls.push(args);
        return { data: "0x1234" };
      },
      async estimateGas() {
        return 12_345n;
      },
    };

    const report = await buildMerchantMoeForkSimulationReport(
      await readiness({
        MERCHANT_MOE_SLIPPAGE_BPS: "100",
        MERCHANT_MOE_DEADLINE_SECONDS: "1200",
      }),
      loadMerchantMoeForkSimulationConfig({
        MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
        MERCHANT_MOE_FORK_RPC_URL: "http://127.0.0.1:8545",
        MERCHANT_MOE_SIMULATION_FROM: from,
      }),
      client,
      quote,
    );

    const routerCall = calls[0] as { data: `0x${string}`; to: `0x${string}` };
    const decoded = decodeFunctionData({ abi: LB_ROUTER_SWAP_ABI, data: routerCall.data });
    expect(report.ok).toBe(true);
    expect(report.calldataSource).toBe("auto");
    expect(report.recipient).toBe(from);
    expect(report.calldataBytes).toBeGreaterThan(4);
    expect(report.findings.map((finding) => finding.ruleId)).not.toContain("CALLDATA_MISSING");
    expect(routerCall.to).toBe(router);
    expect(decoded.functionName).toBe("swapExactTokensForTokens");
    expect(decoded.args[0]).toBe(1000n);
    expect(decoded.args[1]).toBe(891n);
    expect(decoded.args[2]).toEqual({
      pairBinSteps: [25n],
      versions: [3],
      tokenPath: [tokenA, tokenB],
    });
    expect(decoded.args[3]).toBe(from);
  });

  it("records simulation failures as blockers", async () => {
    const client: ForkSimulationClient = {
      async call() {
        throw new Error("ERC20: transfer amount exceeds balance");
      },
    };

    const report = await buildMerchantMoeForkSimulationReport(
      await readiness(),
      loadMerchantMoeForkSimulationConfig({
        MERCHANT_MOE_ENABLE_FORK_SIMULATION: "true",
        MERCHANT_MOE_FORK_RPC_URL: "http://127.0.0.1:8545",
        MERCHANT_MOE_SIMULATION_FROM: from,
        MERCHANT_MOE_SWAP_CALLDATA: "0xabcdef12",
      }),
      client,
    );

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.ruleId)).toContain("SIMULATION_FAILED");
    expect(report.simulation?.revertReason).toContain("ERC20");
  });

  it("formats and traces simulation reports without submitting transactions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "merchant-moe-fork-sim-"));
    const trace = createJsonlTraceWriter({ path: path.join(dir, "events.jsonl") });
    const writes: string[] = [];
    const adapter = {
      async quoteExactInput() {
        return quote;
      },
    };

    const report = await runMerchantMoeForkSimulation(
      adapter,
      {
        MERCHANT_MOE_ROUTE: `${tokenA},${tokenB}`,
        MERCHANT_MOE_AMOUNT_IN_WEI: "1000",
      },
      (message) => writes.push(message),
      trace,
    );

    const output = formatMerchantMoeForkSimulation(report);
    const [event] = (await readFile(trace.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(output).toContain("[merchant-moe] mainnet-fork simulation");
    expect(output).toContain("execution: disabled");
    expect(writes[0]).toContain("mainnet-fork simulation");
    expect(event.type).toBe("merchant_moe.fork_simulation");
    expect(event.report.executionEnabled).toBe(false);
  });
});
