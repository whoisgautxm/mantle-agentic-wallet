import { describe, expect, it } from "vitest";
import { runApprovedCandidateExecutionFixture } from "./approvedCandidateExecutionFixture.js";

describe("approved candidate execution fixture", () => {
  it("proves an approved candidate can pass revalidation, price freshness, simulation, risk, and cost gate", async () => {
    const report = await runApprovedCandidateExecutionFixture();

    expect(report.ok).toBe(true);
    expect(report.finalOutcome).toBe("ready_to_submit");
    expect(report.initialCandidate?.action).toBe("buy");
    expect(report.modelAssessment?.verdict).toBe("approve");
    expect(report.revalidation).toMatchObject({ ok: true, refreshedCandidateGate: "candidate_ready" });
    expect(report.simulation).toMatchObject({ ok: true });
    expect(report.risk).toMatchObject({ ok: true });
    expect(report.blockFreshness?.ok).toBe(false);
    expect(report.priceFreshness?.ok).toBe(true);
    expect(report.costGate?.ok).toBe(true);
  });

  it("blocks at the cost gate when the approved candidate is still uneconomic", async () => {
    const report = await runApprovedCandidateExecutionFixture({
      gasPriceWei: 5_000_000_000_000n,
    });

    expect(report.ok).toBe(false);
    expect(report.finalOutcome).toBe("blocked");
    expect(report.blockedAt).toBe("cost_gate");
    expect(report.costGate?.ok).toBe(false);
    expect(report.risk).toMatchObject({ ok: true });
  });

  it("blocks at freshness when price drift invalidates the revalidated quote", async () => {
    const report = await runApprovedCandidateExecutionFixture({
      currentDexPriceWei: 2_150_000_000_000_000_000n,
      currentOracle: {
        pair: "MNT/MOCK",
        priceWei: 2_150_000_000_000_000_000n,
        source: "mockdex",
        updatedAt: 1_000n,
        stale: false,
        maxAgeSeconds: 300n,
      },
      maxPriceFreshnessBps: 150n,
    });

    expect(report.ok).toBe(false);
    expect(report.finalOutcome).toBe("blocked");
    expect(report.blockedAt).toBe("freshness");
    expect(report.blockFreshness?.ok).toBe(false);
    expect(report.priceFreshness?.ok).toBe(false);
  });
});
