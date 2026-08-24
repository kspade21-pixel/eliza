import { describe, expect, it } from "vitest";
import { CoinGeckoKeylessQuoteSource } from "../src/index.js";

describe("streaming public response limits", () => {
  it("rejects a chunked quote body as soon as it exceeds the byte cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.enqueue(new Uint8Array(20_000));
        controller.close();
      },
    });
    const source = new CoinGeckoKeylessQuoteSource(
      (async () => new Response(body)) as unknown as typeof fetch,
    );
    await expect(source.quote("BTC")).rejects.toThrow(
      "PUBLIC_QUOTE_RESPONSE_TOO_LARGE",
    );
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const source = new CoinGeckoKeylessQuoteSource(
      (async () => new Response("€".repeat(11_000))) as unknown as typeof fetch,
    );
    await expect(source.quote("ETH")).rejects.toThrow(
      "PUBLIC_QUOTE_RESPONSE_TOO_LARGE",
    );
  });

  it("rejects historical bar counts beyond the requested bound", async () => {
    const prices = Array.from({ length: 40 }, (_, index) => [
      1_770_000_000_000 + index * 86_400_000,
      100 + index,
    ]);
    const source = new CoinGeckoKeylessQuoteSource(
      (async () =>
        new Response(JSON.stringify({ prices }))) as unknown as typeof fetch,
      () => 1_800_000_000_000,
    );
    await expect(source.history("BTC", 30)).rejects.toThrow(
      "PUBLIC_HISTORY_TOO_MANY_BARS",
    );
  });
});
