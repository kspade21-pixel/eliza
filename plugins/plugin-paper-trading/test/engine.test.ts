import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAPER_POLICY, PaperTradingEngine } from "../src/index.js";
import type { PaperOrder } from "../src/types.js";

const NOW = 1_787_545_600_000;
const BTC_PRICE_MICROS = 50_000_000_000n;

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    idempotencyKey: "paper-order-1",
    side: "buy",
    symbol: "BTC",
    quantityAtomic: 2_000n,
    quote: {
      symbol: "BTC",
      priceMicros: BTC_PRICE_MICROS,
      observedAtMs: NOW - 1_000,
      source: "verified-test-fixture",
    },
    requestedAtMs: NOW,
    ...overrides,
  };
}

describe("PaperTradingEngine", () => {
  it("starts with exactly $20 simulated cash and no exposure", () => {
    const engine = new PaperTradingEngine();
    expect(engine.snapshot()).toMatchObject({
      mode: "PAPER",
      cashMicros: "20000000",
      grossExposureMicros: "0",
      equityMicros: "20000000",
      halted: false,
      positions: [],
      auditLength: 0,
    });
  });

  it("fills deterministically, charges conservative costs, and is idempotent", () => {
    const engine = new PaperTradingEngine();
    const request = order();
    const first = engine.execute(request);
    const retry = engine.execute(request);

    expect(first).toBe(retry);
    expect(first).toMatchObject({
      mode: "PAPER",
      accepted: true,
      reason: "SIMULATED_FILL",
      executionPriceMicros: "50100000000",
      notionalMicros: "1002000",
      feeMicros: "1002",
      cashBeforeMicros: "20000000",
      cashAfterMicros: "18996998",
    });
    expect(engine.audit).toHaveLength(1);
    expect(engine.verifyAuditChain()).toBe(true);
  });

  it("rejects stale and over-limit orders without changing the simulated ledger", () => {
    const engine = new PaperTradingEngine();
    const stale = engine.execute(
      order({
        idempotencyKey: "stale",
        quote: {
          symbol: "BTC",
          priceMicros: BTC_PRICE_MICROS,
          observedAtMs: NOW - DEFAULT_PAPER_POLICY.maxQuoteAgeMs - 1,
          source: "verified-test-fixture",
        },
      }),
    );
    const tooLarge = engine.execute(
      order({
        idempotencyKey: "too-large",
        quantityAtomic: 5_000n,
      }),
    );

    expect(stale).toMatchObject({
      accepted: false,
      reason: "STALE_OR_FUTURE_QUOTE",
    });
    expect(tooLarge).toMatchObject({
      accepted: false,
      reason: "MAX_ORDER_EXCEEDED",
    });
    expect(engine.snapshot()).toMatchObject({
      cashMicros: "20000000",
      grossExposureMicros: "0",
      positions: [],
      auditLength: 2,
    });
    expect(engine.verifyAuditChain()).toBe(true);
  });

  it("closes a simulated position without allowing a short", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    const sell = engine.execute(
      order({
        idempotencyKey: "paper-sell-1",
        side: "sell",
      }),
    );
    const shortAttempt = engine.execute(
      order({
        idempotencyKey: "paper-short-1",
        side: "sell",
      }),
    );

    expect(sell).toMatchObject({
      accepted: true,
      reason: "SIMULATED_FILL",
      executionPriceMicros: "49900000000",
      notionalMicros: "998000",
      feeMicros: "998",
      cashAfterMicros: "19994000",
    });
    expect(shortAttempt).toMatchObject({
      accepted: false,
      reason: "INSUFFICIENT_PAPER_POSITION",
    });
    expect(engine.snapshot()).toMatchObject({
      cashMicros: "19994000",
      realizedPnlMicros: "-6000",
      positions: [],
    });
  });

  it("detects audit tampering", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    engine.audit[0]!.reason = "ALTERED";
    expect(engine.verifyAuditChain()).toBe(false);
  });

  it("contains no live wallet, exchange, or credential dependency path", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const source = fs
      .readdirSync(path.join(root, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => fs.readFileSync(path.join(root, "src", name), "utf8"))
      .join("\n");

    expect(packageJson.dependencies).toEqual({ "@elizaos/core": "workspace:*" });
    expect(source).not.toMatch(
      /from\s+["'][^"']*(wallet|exchange|ethers|viem|solana|web3)/i,
    );
    expect(source).not.toMatch(/process\.env|private.?key|seed.?phrase|api.?key/i);
  });
});
