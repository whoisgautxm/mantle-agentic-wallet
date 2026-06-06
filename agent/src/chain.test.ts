import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Decision } from "./types.js";

const vault = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const account = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const target = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const hash = `0x${"1".repeat(64)}` as const;
let submitExecute: typeof import("./chain.js").submitExecute;

const decision: Extract<Decision, { kind: "execute" }> = {
  kind: "execute",
  action: "buy",
  target,
  valueWei: 1n,
  calldata: "0x12345678",
  rationale: "submit simulation test",
};

beforeAll(async () => {
  process.env.MANTLE_RPC_URL = "http://127.0.0.1:8545";
  process.env.AGENT_PRIVATE_KEY = `0x${"2".repeat(64)}`;
  ({ submitExecute } = await import("./chain.js"));
}, 15_000);

describe("submitExecute", () => {
  it("blocks writes when the supplied simulation failed", async () => {
    const writeContract = vi.fn();
    const client = { account: { address: account }, writeContract };

    await expect(
      submitExecute(vault, decision, client as any, { simulation: { ok: false, reason: "paused" } }),
    ).rejects.toThrow(/paused/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("runs simulation before writing when no precomputed result is supplied", async () => {
    const writeContract = vi.fn(async () => hash);
    const simulator = vi.fn(async () => ({ ok: true, gasEstimate: 30_000n, warnings: [] }));
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" as const }));
    const client = { account: { address: account }, writeContract };

    const result = await submitExecute(vault, decision, client as any, {
      simulator,
      waitForTransactionReceipt,
    });

    expect(result).toBe(hash);
    expect(simulator).toHaveBeenCalledWith(vault, decision, account, { client: undefined });
    expect(writeContract).toHaveBeenCalledOnce();
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(hash);
  });
});
