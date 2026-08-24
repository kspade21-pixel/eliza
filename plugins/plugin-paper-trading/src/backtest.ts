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
  finalSignal: "BUY" | "HOLD" | "EXIT" | "WAIT";
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
): BacktestResult {
  if (
    !Number.isInteger(policy.fastWindow) ||
    !Number.isInteger(policy.slowWindow) ||
    policy.fastWindow <= 0 ||
    policy.slowWindow <= policy.fastWindow ||
    input.length < policy.slowWindow
  ) {
    throw new Error("BACKTEST_INSUFFICIENT_OR_INVALID_INPUT");
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

  for (let index = policy.slowWindow - 1; index < input.length; index += 1) {
    const bar = input[index]!;
    const fast = average(input, index, policy.fastWindow);
    const slow = average(input, index, policy.slowWindow);
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
      finalSignal = quantity > 0n ? (bullish ? "HOLD" : "EXIT") : bullish ? "BUY" : "WAIT";
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

  return {
    mode: "PAPER_BACKTEST",
    bars: input.length,
    trades,
    initialEquityMicros: policy.initialCashMicros.toString(),
    endingEquityMicros: endingEquity.toString(),
    returnBps: returnBps.toString(),
    maxDrawdownBps: maxDrawdownBps.toString(),
    finalSignal,
  };
}
