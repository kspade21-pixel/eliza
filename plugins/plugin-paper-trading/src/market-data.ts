import type { HistoricalPrice } from "./backtest.js";
import { type PublicMarketQuote, USD_SCALE } from "./types.js";

const IDS = { BTC: "bitcoin", ETH: "ethereum" } as const;
const MAX_RESPONSE_BYTES = 32_768;
const CACHE_MS = 15_000;

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("PUBLIC_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes)
      throw new Error("PUBLIC_RESPONSE_TOO_LARGE");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response limit exceeded");
        throw new Error("PUBLIC_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

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
    let body: string;
    try {
      body = await readBoundedBody(response, 1_048_576);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PUBLIC_RESPONSE_TOO_LARGE"
      ) {
        throw new Error("PUBLIC_HISTORY_RESPONSE_TOO_LARGE");
      }
      throw error;
    }
    const parsed = JSON.parse(body) as { prices?: unknown };
    if (!Array.isArray(parsed.prices)) {
      throw new Error("PUBLIC_HISTORY_MALFORMED");
    }

    const rawPrices = parsed.prices.map((row): HistoricalPrice => {
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
    const dayMs = 86_400_000;
    const currentUtcDay = Math.floor(this.now() / dayMs) * dayMs;
    const completedByDay = new Map<number, HistoricalPrice>();
    for (const price of rawPrices) {
      const utcDay = Math.floor(price.observedAtMs / dayMs) * dayMs;
      if (utcDay >= currentUtcDay) continue;
      completedByDay.set(utcDay, {
        observedAtMs: utcDay,
        priceMicros: price.priceMicros,
      });
    }
    const prices = [...completedByDay.values()].sort(
      (left, right) => left.observedAtMs - right.observedAtMs,
    );
    if (prices.length <= 20) throw new Error("PUBLIC_HISTORY_INSUFFICIENT");
    if (prices.length > days + 1)
      throw new Error("PUBLIC_HISTORY_TOO_MANY_BARS");
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
    let body: string;
    try {
      body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PUBLIC_RESPONSE_TOO_LARGE"
      ) {
        throw new Error("PUBLIC_QUOTE_RESPONSE_TOO_LARGE");
      }
      throw error;
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
