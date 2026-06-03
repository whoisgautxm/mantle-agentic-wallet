import { describe, expect, it } from "vitest";
import { parseDemoArgs } from "./demoStart.js";

describe("demo start options", () => {
  it("uses safe defaults", () => {
    const options = parseDemoArgs([], {});
    expect(options).toMatchObject({
      keeper: true,
      agent: true,
      baseline: true,
      dashboard: true,
      scenarioEval: true,
      traceEvalOnStop: true,
      port: 3000,
    });
  });

  it("parses component and dashboard flags", () => {
    const options = parseDemoArgs(["--no-agent", "--no-baseline", "--prod-dashboard", "--port", "4000"], {});
    expect(options.agent).toBe(false);
    expect(options.baseline).toBe(false);
    expect(options.prodDashboard).toBe(true);
    expect(options.port).toBe(4000);
  });

  it("honors eval env defaults", () => {
    const options = parseDemoArgs([], {
      DEMO_RUN_SCENARIO_EVAL: "false",
      DEMO_RUN_TRACE_EVAL_ON_STOP: "false",
      DEMO_DASHBOARD_PORT: "3100",
    });
    expect(options.scenarioEval).toBe(false);
    expect(options.traceEvalOnStop).toBe(false);
    expect(options.port).toBe(3100);
  });

  it("rejects invalid ports", () => {
    expect(() => parseDemoArgs(["--port=99999"], {})).toThrow(/invalid dashboard port/);
  });
});
