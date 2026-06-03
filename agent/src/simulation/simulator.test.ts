import { describe, expect, it } from "vitest";
import { assertSimulationSucceeded, simulateExecute, type ExecuteSimulationClient } from "./simulator.js";
import type { Decision } from "../types.js";

const vault = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const account = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const target = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

const decision: Extract<Decision, { kind: "execute" }> = {
  kind: "execute",
  action: "buy",
  target,
  valueWei: 123n,
  calldata: "0x12345678",
  rationale: "simulation test",
};

describe("simulateExecute", () => {
  it("simulates AgentVault.execute and captures a gas estimate", async () => {
    const client: ExecuteSimulationClient = {
      async simulateContract(params: any) {
        expect(params.address).toBe(vault);
        expect(params.functionName).toBe("execute");
        expect(params.account).toBe(account);
        expect(params.args).toEqual([target, 123n, "0x12345678", "simulation test"]);
        return { result: "0x" };
      },
      async estimateContractGas(params: any) {
        expect(params.address).toBe(vault);
        return 45_000n;
      },
    };

    const result = await simulateExecute(vault, decision, account, { client });
    expect(result).toEqual({ ok: true, returnData: "0x", gasEstimate: 45_000n, warnings: [] });
  });

  it("keeps a successful simulation when gas estimation is unavailable", async () => {
    const client: ExecuteSimulationClient = {
      async simulateContract() {
        return { result: "0x" };
      },
      async estimateContractGas() {
        throw new Error("rate limited");
      },
    };

    const result = await simulateExecute(vault, decision, account, { client });
    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toMatch(/gas estimate unavailable/i);
  });

  it("normalizes failed simulations into blocker-ready reasons", async () => {
    const client: ExecuteSimulationClient = {
      async simulateContract() {
        throw { shortMessage: "execution reverted: paused" };
      },
    };

    const result = await simulateExecute(vault, decision, account, { client });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("execution reverted: paused");
    expect(result.revertReason).toBe("execution reverted: paused");
  });

  it("throws when a submitter attempts to continue after a failed simulation", () => {
    expect(() => assertSimulationSucceeded({ ok: false, reason: "target not allowed" })).toThrow(/target not allowed/);
  });
});
