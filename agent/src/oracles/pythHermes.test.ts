import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PYTH_MNT_USD_PRICE_ID,
  createPythMntUsdOracleRouter,
  fetchPythMntUsdPrice,
  loadPythHermesConfigFromEnv,
  pythPriceToMntPerUsdWei,
  pythPriceToUsdPerMntWei,
  type PythFetch,
} from "./pythHermes.js";

const freshPublishTime = 1_800_000_000;
const price = {
  price: "80000000",
  conf: "1000000",
  expo: -8,
  publish_time: freshPublishTime,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Pyth Hermes oracle", () => {
  it("loads safe defaults for the MNT/USD feed", () => {
    const config = loadPythHermesConfigFromEnv({});
    expect(config.hermesUrl).toBe("https://hermes.pyth.network");
    expect(config.priceId).toBe(PYTH_MNT_USD_PRICE_ID);
    expect(config.maxAgeSeconds).toBe(120n);
  });

  it("converts USD/MNT into the MNT/USD-like e18 price used by MockDEX risk checks", () => {
    expect(pythPriceToUsdPerMntWei(price)).toBe(800_000_000_000_000_000n);
    expect(pythPriceToMntPerUsdWei(price)).toBe(1_250_000_000_000_000_000n);
  });

  it("fetches the latest MNT/USD price through Hermes v2", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchFn: PythFetch = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            parsed: [{ id: PYTH_MNT_USD_PRICE_ID.slice(2), price }],
          };
        },
      };
    };

    const result = await fetchPythMntUsdPrice(
      {
        hermesUrl: "https://hermes.pyth.network/",
        priceId: PYTH_MNT_USD_PRICE_ID,
        apiKey: "test-key",
        maxAgeSeconds: 120n,
      },
      fetchFn,
    );

    expect(result).toEqual(price);
    expect(calls[0].url).toContain("/v2/updates/price/latest");
    expect(calls[0].url).toContain(encodeURIComponent(PYTH_MNT_USD_PRICE_ID));
    expect(calls[0].headers?.Authorization).toBe("Bearer test-key");
  });

  it("marks stale Pyth prices without throwing", async () => {
    vi.setSystemTime(new Date((freshPublishTime + 121) * 1000));
    const fetchFn: PythFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { parsed: [{ id: PYTH_MNT_USD_PRICE_ID, price }] };
      },
    });

    const router = createPythMntUsdOracleRouter(
      {
        hermesUrl: "https://hermes.pyth.network",
        priceId: PYTH_MNT_USD_PRICE_ID,
        maxAgeSeconds: 120n,
      },
      fetchFn,
    );
    const snapshot = await router.getPrice("MNT/MOCK");

    expect(snapshot.source).toBe("pyth");
    expect(snapshot.priceWei).toBe(1_250_000_000_000_000_000n);
    expect(snapshot.stale).toBe(true);
  });

  it("fails closed on invalid feed ids and missing prices", async () => {
    const fetchFn: PythFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { parsed: [] };
      },
    });

    await expect(fetchPythMntUsdPrice({ hermesUrl: "https://hermes.pyth.network", priceId: "bad", maxAgeSeconds: 1n }, fetchFn)).rejects.toThrow(/price id/);
    await expect(
      fetchPythMntUsdPrice(
        { hermesUrl: "https://hermes.pyth.network", priceId: PYTH_MNT_USD_PRICE_ID, maxAgeSeconds: 1n },
        fetchFn,
      ),
    ).rejects.toThrow(/missing price/);
  });
});
