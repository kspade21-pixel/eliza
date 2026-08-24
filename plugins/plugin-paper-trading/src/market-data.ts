import type { HistoricalPrice } from "./backtest.js";
import { USD_SCALE, type PublicMarketQuote } from "./types.js";

const IDS = { BTC: "bitcoin", ETH: "ethereum" } as const;
const MAX_RESPONSE_BYTES = 32_768;
const CACHE_MS = 15_000;

type SupportedSymbol = keyof typeof IDS;
type FetchLike = typeof fetch;

interface CacheEntry {
  quote: PublicMarketQuote;
  cachedAtMs: number;
}

export class CoinGeckoKeylessQuoteSource {
  readonly #cache = new Map<SupportedSymbol, CacheEntry>();

  constructor(
    readonly fetcher: FetchLike = fetch,
    readonly now: () => number = Date.now,
  ) {}

  async history(
    symbolInput: string,
    days: 30 | 90 | 180 | 365 = 90,
  ): Promise<HistoricalPrice[]> {
    const symbol = symbolInput.trim().toUpperCase() as SupportedSymbol;
    const id = IDS[symbol];
    if (!id) throw new Error("PUBLIC_HISTORY_SYMBOL_NOT_SUPPORTED");
    if (![30, 90, 180, 365].includes(days)) {
      throw new Error("PUBLIC_HISTORY_DAYS_NOT_SUPPORTED");
    }

    const url = new URL(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart`,
    );
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("days", String(days));
    url.searchParams.set("interval", "daily");

    const response = await this.fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`PUBLIC_HISTORY_HTTP_${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1_048_576) {
      throw new Error("PUBLIC_HISTORY_RESPONSE_TOO_LARGE");
    }
    const body = await response.text();
    if (body.length > 1_048_576) {
      throw new Error("PUBLIC_HISTORY_RESPONSE_TOO_LARGE");
    }
    const parsed = JSON.parse(body) as { prices?: unknown };
    if (!Array.isArray(parsed.prices)) {
      throw new Error("PUBLIC_HISTORY_MALFORMED");
    }

    const prices = parsed.prices.map((row): HistoricalPrice => {
      if (
        !Array.isArray(row) ||
        row.length < 2 ||
        typeof row[0] !== "number" ||
        !Number.isSafeInteger(row[0]) ||
        typeof row[1] !== "number" ||
        !Number.isFinite(row[1]) ||
        row[1] <= 0
      ) {
        throw new Error("PUBLIC_HISTORY_MALFORMED");
      }
      return {
        observedAtMs: row[0],
        priceMicros: BigInt(Math.round(row[1] * Number(USD_SCALE))),
      };
    });
    if (prices.length < 20) throw new Error("PUBLIC_HISTORY_INSUFFICIENT");
    return prices;
  }

  async quote(symbolInput: string): Promise<PublicMarketQuote> {
    const symbol = symbolInput.trim().toUpperCase() as SupportedSymbol;
    const id = IDS[symbol];
    if (!id) throw new Error("PUBLIC_QUOTE_SYMBOL_NOT_SUPPORTED");

    const now = this.now();
    const cached = this.#cache.get(symbol);
    if (cached && now - cached.cachedAtMs <= CACHE_MS) return cached.quote;

    const url = new URL("https://api.coingecko.com/api/v3/simple/price");
    url.searchParams.set("ids", id);
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_last_updated_at", "true");

    const response = await this.fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`PUBLIC_QUOTE_HTTP_${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new Error("PUBLIC_QUOTE_RESPONSE_TOO_LARGE");
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new Error("PUBLIC_QUOTE_RESPONSE_TOO_LARGE");
    }
    const parsed = JSON.parse(body) as Record<
      string,
      { usd?: unknown; last_updated_at?: unknown }
    >;
    const usd = parsed[id]?.usd;
    const updated = parsed[id]?.last_updated_at;
    if (
      typeof usd !== "number" ||
      !Number.isFinite(usd) ||
      usd <= 0 ||
      typeof updated !== "number" ||
      !Number.isSafeInteger(updated) ||
      updated <= 0
    ) {
      throw new Error("PUBLIC_QUOTE_MALFORMED");
    }
    const priceMicros = BigInt(Math.round(usd * Number(USD_SCALE)));
    if (priceMicros <= 0n) throw new Error("PUBLIC_QUOTE_MALFORMED");

    const quote: PublicMarketQuote = {
      symbol,
      priceMicros,
      observedAtMs: updated * 1_000,
      source: "coingecko-keyless",
    };
    this.#cache.set(symbol, { quote, cachedAtMs: now });
    return quote;
  }
}
