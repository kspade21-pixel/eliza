import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CoinGeckoKeylessQuoteSource,
  type PaperEngineState,
  type PaperOrder,
  PaperStateStore,
  PaperTradingEngine,
  PaperTradingService,
} from "../src/index.js";

describe("restart-safe paper infrastructure", () => {
  it("writes and reloads a versioned state file atomically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-state-"));
    try {
      const file = path.join(directory, "ledger.json");
      const store = new PaperStateStore(file);
      const engine = new PaperTradingEngine();
      store.save(engine.exportState());
      expect(PaperTradingEngine.fromState(store.load()!).snapshot()).toEqual(
        engine.snapshot(),
      );
      expect(fs.readdirSync(directory)).toEqual(["ledger.json"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails service startup closed for legacy state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-state-"));
    try {
      const store = new PaperStateStore(path.join(directory, "ledger.json"));
      const legacy = {
        ...new PaperTradingEngine().exportState(),
        version: 2,
      } as unknown as PaperEngineState;
      store.save(legacy);

      expect(() => new PaperTradingService(undefined, store)).toThrow(
        "INVALID_PAPER_STATE_VERSION",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not persist an invalid runtime order side", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-state-"));
    try {
      const store = new PaperStateStore(path.join(directory, "ledger.json"));
      const service = new PaperTradingService(undefined, store);
      const before = store.load();
      const saveSpy = vi.spyOn(store, "save");
      const invalid = {
        idempotencyKey: "invalid-service-side",
        side: "withdraw",
        symbol: "BTC",
        quantityAtomic: 1_000n,
        quote: {
          symbol: "BTC",
          priceMicros: 50_000_000_000n,
          observedAtMs: 1_787_545_599_000,
          source: "verified-test-fixture",
        },
        requestedAtMs: 1_787_545_600_000,
      } as unknown as PaperOrder;

      expect(() => service.execute(invalid)).toThrow(
        "INVALID_PAPER_ORDER_SIDE",
      );
      expect(store.load()).toEqual(before);
      expect(saveSpy).not.toHaveBeenCalled();

      const restarted = new PaperTradingService(undefined, store);
      expect(restarted.engine.exportState()).toEqual(before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a verified provider timestamp and caches repeated reads", async () => {
    let now = 1_787_545_600_000;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            bitcoin: { usd: 50_000.123456, last_updated_at: now / 1_000 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const fetcher = fetchMock as unknown as typeof fetch;
    const source = new CoinGeckoKeylessQuoteSource(fetcher, () => now);

    const first = await source.quote("BTC");
    now += 1_000;
    const second = await source.quote("BTC");

    expect(first).toEqual({
      symbol: "BTC",
      priceMicros: 50_000_123_456n,
      observedAtMs: 1_787_545_600_000,
      source: "coingecko-keyless",
    });
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "include_last_updated_at=true",
    );
  });

  it("fails closed on malformed or oversized public quote responses", async () => {
    const malformed = new CoinGeckoKeylessQuoteSource(
      (async () =>
        new Response('{"bitcoin":{"usd":"50000"}}')) as unknown as typeof fetch,
    );
    await expect(malformed.quote("BTC")).rejects.toThrow(
      "PUBLIC_QUOTE_MALFORMED",
    );

    const oversized = new CoinGeckoKeylessQuoteSource(
      (async () =>
        new Response("x", {
          headers: { "content-length": "40000" },
        })) as unknown as typeof fetch,
    );
    await expect(oversized.quote("BTC")).rejects.toThrow(
      "PUBLIC_QUOTE_RESPONSE_TOO_LARGE",
    );
  });
});
