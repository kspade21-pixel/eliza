import { createHash } from "node:crypto";
import { ASSET_SCALE, BPS_SCALE } from "./types.js";

export interface HistoricalPrice {
  observedAtMs: number;
  priceMicros: bigint;
}

export interface BacktestResult {
  mode: "PAPER_BACKTEST";
  bars: number;
  trades: number;
  initialEquityMicros: string;
  endingEquityMicros: string;
  returnBps: string;
  maxDrawdownBps: string;
  finalSignal: "BUY" | "HOLD" | "WAIT";
  asOfMs: number;
  evidenceHash: string;
  algorithmVersion: "sma-5-20-next-bar-v1";
}

export interface BacktestContext {
  symbol: string;
  source: string;
  windowDays: number;
}

export interface BacktestPolicy {
  initialCashMicros: bigint;
  allocationMicros: bigint;
  minimumReserveMicros: bigint;
  feeBps: bigint;
  slippageBps: bigint;
  fastWindow: number;
  slowWindow: number;
}

export const DEFAULT_BACKTEST_POLICY: BacktestPolicy = Object.freeze({
  initialCashMicros: 20_000_000n,
  allocationMicros: 2_000_000n,
  minimumReserveMicros: 10_000_000n,
  feeBps: 10n,
  slippageBps: 20n,
  fastWindow: 5,
  slowWindow: 20,
});

function average(values: readonly HistoricalPrice[], end: number, length: number): bigint {
  let total = 0n;
  for (let index = end - length + 1; index <= end; index += 1) {
    total += values[index]!.priceMicros;
  }
  return total / BigInt(length);
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

export function runPaperBacktest(
  input: readonly HistoricalPrice[],
  policy: BacktestPolicy = DEFAULT_BACKTEST_POLICY,
  context: BacktestContext = {
    symbol: "TEST",
    source: "verified-fixture",
    windowDays: input.length,
  },
): BacktestResult {
  if (
    !Number.isInteger(policy.fastWindow) ||
    !Number.isInteger(policy.slowWindow) ||
    policy.fastWindow <= 0 ||
    policy.slowWindow <= policy.fastWindow ||
    input.length <= policy.slowWindow
  ) {
    throw new Error("BACKTEST_INSUFFICIENT_OR_INVALID_INPUT");
  }
  if (
    policy.initialCashMicros <= 0n ||
    policy.allocationMicros < 0n ||
    policy.minimumReserveMicros < 0n ||
    policy.minimumReserveMicros > policy.initialCashMicros ||
    policy.feeBps < 0n ||
    policy.feeBps >= BPS_SCALE ||
    policy.slippageBps < 0n ||
    policy.slippageBps >= BPS_SCALE
  ) {
    throw new Error("BACKTEST_INVALID_POLICY");
  }
  if (
    !context.symbol.trim() ||
    !context.source.trim() ||
    !Number.isSafeInteger(context.windowDays) ||
    context.windowDays <= 0
  ) {
    throw new Error("BACKTEST_INVALID_CONTEXT");
  }
  for (const [index, bar] of input.entries()) {
    if (
      !Number.isSafeInteger(bar.observedAtMs) ||
      bar.observedAtMs <= 0 ||
      bar.priceMicros <= 0n ||
      (index > 0 && bar.observedAtMs <= input[index - 1]!.observedAtMs)
    ) {
      throw new Error("BACKTEST_INVALID_PRICE_SERIES");
    }
  }

  let cash = policy.initialCashMicros;
  let quantity = 0n;
  let trades = 0;
  let peakEquity = cash;
  let maxDrawdownBps = 0n;
  let finalSignal: BacktestResult["finalSignal"] = "WAIT";

  // Signal only from completed bars through index - 1, then execute on index.
  // This prevents same-close look-ahead bias.
  for (let index = policy.slowWindow; index < input.length; index += 1) {
    const bar = input[index]!;
    const signalEnd = index - 1;
    const fast = average(input, signalEnd, policy.fastWindow);
    const slow = average(input, signalEnd, policy.slowWindow);
    const bullish = fast > slow;

    if (bullish && quantity === 0n) {
      const available = cash - policy.minimumReserveMicros;
      const budget = available < policy.allocationMicros ? available : policy.allocationMicros;
      if (budget > 0n) {
        const executionPrice = ceilDiv(
          bar.priceMicros * (BPS_SCALE + policy.slippageBps),
          BPS_SCALE,
        );
        const feeBudget = ceilDiv(budget * policy.feeBps, BPS_SCALE);
        const spendable = budget - feeBudget;
        const candidateQuantity = (spendable * ASSET_SCALE) / executionPrice;
        const notional = ceilDiv(executionPrice * candidateQuantity, ASSET_SCALE);
        const fee = ceilDiv(notional * policy.feeBps, BPS_SCALE);
        if (candidateQuantity > 0n && notional + fee <= budget) {
          quantity = candidateQuantity;
          cash -= notional + fee;
          trades += 1;
        }
      }
      finalSignal = quantity > 0n ? "HOLD" : "BUY";
    } else if (!bullish && quantity > 0n) {
      const executionPrice =
        (bar.priceMicros * (BPS_SCALE - policy.slippageBps)) / BPS_SCALE;
      const notional = (executionPrice * quantity) / ASSET_SCALE;
      const fee = ceilDiv(notional * policy.feeBps, BPS_SCALE);
      cash += notional - fee;
      quantity = 0n;
      trades += 1;
      finalSignal = "WAIT";
    } else {
      finalSignal = quantity > 0n ? "HOLD" : bullish ? "BUY" : "WAIT";
    }

    const equity = cash + (bar.priceMicros * quantity) / ASSET_SCALE;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity > 0n) {
      const drawdown = ((peakEquity - equity) * BPS_SCALE) / peakEquity;
      if (drawdown > maxDrawdownBps) maxDrawdownBps = drawdown;
    }
  }

  const last = input.at(-1)!;
  const endingEquity = cash + (last.priceMicros * quantity) / ASSET_SCALE;
  const returnBps =
    ((endingEquity - policy.initialCashMicros) * BPS_SCALE) /
    policy.initialCashMicros;

  const algorithmVersion = "sma-5-20-next-bar-v1" as const;
  const evidenceHash = createHash("sha256")
    .update(
      JSON.stringify({
        algorithmVersion,
        context: {
          symbol: context.symbol.trim().toUpperCase(),
          source: context.source.trim(),
          windowDays: context.windowDays,
        },
        policy: {
          initialCashMicros: policy.initialCashMicros.toString(),
          allocationMicros: policy.allocationMicros.toString(),
          minimumReserveMicros: policy.minimumReserveMicros.toString(),
          feeBps: policy.feeBps.toString(),
          slippageBps: policy.slippageBps.toString(),
          fastWindow: policy.fastWindow,
          slowWindow: policy.slowWindow,
        },
        bars: input.map((bar) => [
          bar.observedAtMs,
          bar.priceMicros.toString(),
        ]),
      }),
    )
    .digest("hex");

  return {
    mode: "PAPER_BACKTEST",
    bars: input.length,
    trades,
    initialEquityMicros: policy.initialCashMicros.toString(),
    endingEquityMicros: endingEquity.toString(),
    returnBps: returnBps.toString(),
    maxDrawdownBps: maxDrawdownBps.toString(),
    finalSignal,
    asOfMs: last.observedAtMs,
    evidenceHash,
    algorithmVersion,
  };
}
