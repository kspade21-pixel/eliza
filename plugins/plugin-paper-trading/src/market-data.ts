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
