import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_POLICY,
  type HistoricalPrice,
  runPaperBacktest,
} from "../src/index.js";

const DAY = 86_400_000;
const START = 1_780_000_000_000;

function series(prices: number[]): HistoricalPrice[] {
  return prices.map((price, index) => ({
    observedAtMs: START + index * DAY,
    priceMicros: BigInt(price) * 1_000_000n,
  }));
}

describe("paper backtesting", () => {
  it("is deterministic and models a bounded long-only trend cycle", () => {
    const prices = [
      ...Array.from({ length: 25 }, (_, index) => 100 + index * 2),
      ...Array.from({ length: 25 }, (_, index) => 148 - index * 3),
    ];
    const first = runPaperBacktest(series(prices));
    const second = runPaperBacktest(series(prices));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: "PAPER_BACKTEST",
      bars: 50,
      trades: 2,
      initialEquityMicros: "20000000",
      finalSignal: "WAIT",
    });
    expect(BigInt(first.maxDrawdownBps)).toBeGreaterThanOrEqual(0n);
  });

  it("does not execute a crossover on the same closing bar", () => {
    const prices = Array(20).fill(100);
    prices.push(1_000);
    const result = runPaperBacktest(series(prices));
    expect(result.trades).toBe(0);
    expect(result.liquidationValueEquityMicros).toBe("20000000");
  });

  it("rejects unsafe custom policy ranges", () => {
    const prices = series(Array(21).fill(100));
    expect(() =>
      runPaperBacktest(prices, {
        ...DEFAULT_BACKTEST_POLICY,
        initialCashMicros: 0n,
      }),
    ).toThrow("BACKTEST_INVALID_POLICY");
    expect(() =>
      runPaperBacktest(prices, {
        ...DEFAULT_BACKTEST_POLICY,
        feeBps: -1n,
      }),
    ).toThrow("BACKTEST_INVALID_POLICY");
    expect(() =>
      runPaperBacktest(prices, {
        ...DEFAULT_BACKTEST_POLICY,
        marketImpactBps: 10_000n,
      }),
    ).toThrow("BACKTEST_INVALID_POLICY");
  });

  it("produces a reproducible input hash and changes it with policy", () => {
    const prices = series(Array(21).fill(100));
    const baseline = runPaperBacktest(prices);
    const changed = runPaperBacktest(prices, {
      ...DEFAULT_BACKTEST_POLICY,
      feeBps: 11n,
    });
    expect(baseline.runManifest.inputSha256).toHaveLength(64);
    expect(changed.runManifest.inputSha256).not.toBe(
      baseline.runManifest.inputSha256,
    );
    expect(baseline.algorithmVersion).toBe(
      "sma-5-20-next-observation-cost-model-v3",
    );
  });

  it("does not invent trades on a flat market", () => {
    const result = runPaperBacktest(series(Array(30).fill(100)));
    expect(result).toMatchObject({
      trades: 0,
      liquidationValueEquityMicros:
        DEFAULT_BACKTEST_POLICY.initialCashMicros.toString(),
      liquidationReturnBps: "0",
      finalSignal: "WAIT",
    });
  });

  it("rejects insufficient, malformed, and unordered history", () => {
    expect(() => runPaperBacktest(series(Array(19).fill(100)))).toThrow(
      "BACKTEST_INSUFFICIENT_OR_INVALID_INPUT",
    );
    const malformed = series(Array(21).fill(100));
    malformed[5] = { ...malformed[5]!, priceMicros: 0n };
    expect(() => runPaperBacktest(malformed)).toThrow(
      "BACKTEST_INVALID_PRICE_SERIES",
    );
    const unordered = series(Array(21).fill(100));
    unordered[10] = {
      ...unordered[10]!,
      observedAtMs: unordered[9]!.observedAtMs,
    };
    expect(() => runPaperBacktest(unordered)).toThrow(
      "BACKTEST_INVALID_PRICE_SERIES",
    );
  });

  it("keeps the configured reserve and allocation bounded", () => {
    const result = runPaperBacktest(
      series(Array.from({ length: 30 }, (_, index) => 100 + index)),
    );
    expect(result.trades).toBe(1);
    expect(BigInt(result.liquidationValueEquityMicros)).toBeGreaterThan(
      10_000_000n,
    );
  });

  it("reports benchmarks, friction scenarios, terminal values, warnings, and gaps", () => {
    const values = series(
      Array.from({ length: 60 }, (_, index) => 100 + index),
    );
    values[40] = {
      ...values[40]!,
      observedAtMs: values[40]!.observedAtMs + DAY,
    };
    for (let index = 41; index < values.length; index++) {
      values[index] = {
        ...values[index]!,
        observedAtMs: values[index]!.observedAtMs + DAY,
      };
    }
    const result = runPaperBacktest(values, undefined, {
      symbol: "BTC",
      source: "fixture",
      windowDays: 60,
      retrievedAtMs: START + 70 * DAY,
    });
    expect(result.scenarios.map((item) => item.name)).toEqual([
      "optimistic",
      "base",
      "stress",
    ]);
    expect(
      result.scenarios.every((item) => item.cashBenchmarkReturnBps === "0"),
    ).toBe(true);
    expect(BigInt(result.markToMarketEquityMicros)).toBeGreaterThanOrEqual(
      BigInt(result.liquidationValueEquityMicros),
    );
    expect(result.coverage).toMatchObject({
      gapCount: 1,
      missingDailyIntervals: 1,
    });
    expect(result.runManifest).toMatchObject({
      schemaVersion: "paper-backtest-run-manifest/v2",
      priceFieldSemantics: "observation-price; not asserted to be market open",
    });
    expect(result.researchStatus).toBe("UNVERIFIED_RESEARCH");
    expect(result.warnings.join(" ")).toContain("LOW_ROUND_TRIPS");
  });

  it("keeps content hash stable across retrieval times", () => {
    const prices = series(Array(30).fill(100));
    const first = runPaperBacktest(prices, undefined, {
      symbol: "BTC",
      source: "fixture",
      windowDays: 30,
      retrievedAtMs: START + 31 * DAY,
    });
    const second = runPaperBacktest(prices, undefined, {
      symbol: "BTC",
      source: "fixture",
      windowDays: 30,
      retrievedAtMs: START + 32 * DAY,
    });
    expect(first.runManifest.retrievedAtMs).not.toBe(
      second.runManifest.retrievedAtMs,
    );
    expect(first.runManifest.inputSha256).toBe(second.runManifest.inputSha256);
  });

  it("uses requested costs for base and keeps illustrative sensitivity ordered", () => {
    const prices = series(
      Array.from({ length: 60 }, (_, index) => 100 + index),
    );
    const low = runPaperBacktest(prices, {
      ...DEFAULT_BACKTEST_POLICY,
      feeBps: 2n,
      spreadBps: 4n,
      marketImpactBps: 3n,
    });
    const high = runPaperBacktest(prices, {
      ...DEFAULT_BACKTEST_POLICY,
      feeBps: 20n,
      spreadBps: 30n,
      marketImpactBps: 40n,
    });
    expect(low.scenarios[1]).toMatchObject({
      feeBps: "2",
      spreadBps: "4",
      marketImpactBps: "3",
      costProvenance: "illustrative-policy-input",
      liquidationValueEquityMicros: "20646290",
      liquidationReturnBps: "323",
    });
    expect(low.runManifest.costModel[1]).toMatchObject({
      feeBps: "2",
      spreadBps: "4",
      marketImpactBps: "3",
      provenance: "illustrative-policy-input",
    });
    expect(low.scenarios[1]!.liquidationValueEquityMicros).not.toBe(
      high.scenarios[1]!.liquidationValueEquityMicros,
    );
    const returns = low.scenarios.map((item) =>
      BigInt(item.liquidationReturnBps),
    );
    expect(returns[0]).toBeGreaterThanOrEqual(returns[1]!);
    expect(returns[1]).toBeGreaterThanOrEqual(returns[2]!);
  });

  it("uses the next observation for a positive fill and has fixed-point golden math", () => {
    const prices = series([...Array(20).fill(100), 200, 300]);
    const result = runPaperBacktest(prices, {
      ...DEFAULT_BACKTEST_POLICY,
      feeBps: 0n,
      spreadBps: 0n,
      marketImpactBps: 0n,
    });
    const base = result.scenarios[1]!;
    // The signal from observation 20 executes at observation 21 (300), not 200.
    expect(base.trades).toBe(1);
    expect(base.markToMarketEquityMicros).toBe("20000000");
    expect(base.liquidationValueEquityMicros).toBe("20000000");
    expect(base.buyHoldLiquidationValueEquityMicros).toBe("21000000");
    expect(base.netVsCashBps).toBe("0");
    expect(base.netVsBuyHoldBps).toBe("-500");
  });

  it("reports same-convention benchmark drawdown and blocks ranking", () => {
    const result = runPaperBacktest(
      series([...Array(20).fill(100), 120, 80, 60, 100, 110]),
    );
    const base = result.scenarios[1]!;
    expect(
      BigInt(base.buyHoldLiquidationAdjustedMaxDrawdownBps),
    ).toBeGreaterThanOrEqual(0n);
    expect(base.profitabilityRanking).toBeNull();
    expect(base.comparisonStatus).toBe("NOT_RANKED_NO_OBSERVED_VENUE_BASIS");
    expect(result.runManifest).toMatchObject({
      venueBasis: "none-observed",
      profitabilityRankingPermitted: false,
      drawdownConvention: "liquidation-value-at-each-observation",
    });
  });

  it("rejects base costs whose derived stress case reaches invalid bounds", () => {
    const prices = series(
      Array.from({ length: 30 }, (_, index) => 100 + index),
    );
    expect(() =>
      runPaperBacktest(prices, {
        ...DEFAULT_BACKTEST_POLICY,
        feeBps: 4_000n,
      }),
    ).toThrow("BACKTEST_INVALID_POLICY");
    expect(() =>
      runPaperBacktest(prices, {
        ...DEFAULT_BACKTEST_POLICY,
        marketImpactBps: 4_000n,
      }),
    ).toThrow("BACKTEST_INVALID_POLICY");
  });

  it("keeps stress liquidation proceeds and equity non-negative at the boundary", () => {
    const result = runPaperBacktest(
      series(Array.from({ length: 60 }, (_, index) => 1 + index)),
      {
        ...DEFAULT_BACKTEST_POLICY,
        feeBps: 3_999n,
        spreadBps: 3_998n,
        marketImpactBps: 2_000n,
      },
    );
    const stress = result.scenarios[2]!;
    expect(BigInt(stress.feeBps)).toBeLessThan(10_000n);
    expect(
      (BigInt(stress.spreadBps) + 1n) / 2n + BigInt(stress.marketImpactBps),
    ).toBeLessThan(10_000n);
    expect(BigInt(stress.liquidationValueEquityMicros)).toBeGreaterThanOrEqual(
      0n,
    );
    expect(
      BigInt(stress.buyHoldLiquidationValueEquityMicros),
    ).toBeGreaterThanOrEqual(0n);
  });
});
