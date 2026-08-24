import { describe, expect, it, vi } from "vitest";
import { CoinGeckoKeylessQuoteSource } from "../src/index.js";

describe("public historical market data", () => {
  it("loads bounded daily BTC history without credentials", async () => {
    const prices = Array.from({ length: 30 }, (_, index) => [
      1_780_000_000_000 + index * 86_400_000,
      50_000 + index,
    ]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ prices }), { status: 200 }),
    );
    const source = new CoinGeckoKeylessQuoteSource(
      fetchMock as unknown as typeof fetch,
    );

    const result = await source.history("BTC", 30);

    expect(result).toHaveLength(30);
    expect(result[0]).toEqual({
      observedAtMs: 1_780_000_000_000,
      priceMicros: 50_000_000_000n,
    });
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain("/coins/bitcoin/market_chart");
    expect(requested).toContain("days=30");
    expect(requested).toContain("interval=daily");
  });

  it("rejects unsupported windows and malformed history", async () => {
    const source = new CoinGeckoKeylessQuoteSource(
      (async () => new Response('{"prices":"bad"}')) as unknown as typeof fetch,
    );
    await expect(source.history("BTC", 30)).rejects.toThrow(
      "PUBLIC_HISTORY_MALFORMED",
    );
    await expect(
      source.history("BTC", 7 as 30),
    ).rejects.toThrow("PUBLIC_HISTORY_DAYS_NOT_SUPPORTED");
  });

  it("rejects oversized history before parsing", async () => {
    const source = new CoinGeckoKeylessQuoteSource(
      (async () =>
        new Response("x", {
          headers: { "content-length": "1048577" },
        })) as unknown as typeof fetch,
    );
    await expect(source.history("ETH", 90)).rejects.toThrow(
      "PUBLIC_HISTORY_RESPONSE_TOO_LARGE",
    );
  });
});
