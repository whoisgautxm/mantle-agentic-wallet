import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { computeMarketFeatures, formatMarketFeatures } from "./marketFeatures.js";

const prices = (values: string[]) => values.map((value) => parseEther(value));

describe("market features", () => {
  it("classifies a sustained rally without future observations", () => {
    const features = computeMarketFeatures(prices(["1.00", "1.03", "1.07", "1.12", "1.18"]));

    expect(features.regime).toBe("trend_up");
    expect(features.consecutiveUp).toBe(4);
    expect(features.shortSlopeBps).toBeGreaterThan(1_000);
    expect(features.confidence).toBeGreaterThanOrEqual(70);
  });

  it("classifies a sustained selloff and reports peak drawdown", () => {
    const features = computeMarketFeatures(prices(["1.20", "1.15", "1.08", "1.00", "0.92"]));

    expect(features.regime).toBe("trend_down");
    expect(features.consecutiveDown).toBe(4);
    expect(features.drawdownFromPeakBps).toBeLessThan(-2_000);
  });

  it("classifies a large one-tick move as a shock", () => {
    const features = computeMarketFeatures(prices(["1.00", "1.01", "0.72"]));

    expect(features.regime).toBe("shock");
    expect(features.latestReturnBps).toBeLessThan(-2_000);
    expect(formatMarketFeatures(features)).toContain("deterministicRegime=shock");
  });

  it("stays uncertain until enough observations exist", () => {
    expect(computeMarketFeatures(prices(["1.00", "1.01"])).regime).toBe("uncertain");
  });
});
