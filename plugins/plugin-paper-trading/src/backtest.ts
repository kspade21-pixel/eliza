import { createHash } from "node:crypto";
import { ASSET_SCALE, BPS_SCALE } from "./types.js";

export interface HistoricalPrice { observedAtMs: number; priceMicros: bigint }
export interface BacktestContext { symbol: string; source: string; windowDays: number; retrievedAtMs?: number }
export interface BacktestPolicy {
  initialCashMicros: bigint; allocationMicros: bigint; minimumReserveMicros: bigint;
  feeBps: bigint; slippageBps: bigint; fastWindow: number; slowWindow: number;
}
export interface ScenarioResult {
  name: "optimistic" | "base" | "stress"; feeBps: string; slippageBps: string;
  assumptions: string; trades: number; roundTrips: number;
  markToMarketEquityMicros: string; markToMarketReturnBps: string;
  liquidationValueEquityMicros: string; liquidationReturnBps: string;
  cashBenchmarkEquityMicros: string; cashBenchmarkReturnBps: "0";
  buyHoldMarkToMarketEquityMicros: string; buyHoldMarkToMarketReturnBps: string;
  buyHoldLiquidationValueEquityMicros: string; buyHoldLiquidationReturnBps: string;
  netVsCashBps: string; netVsBuyHoldBps: string; maxDrawdownBps: string;
}
export interface BacktestResult {
  mode: "PAPER_BACKTEST"; researchStatus: "UNVERIFIED_RESEARCH";
  bars: number; decisionBars: number; trades: number; roundTrips: number;
  initialEquityMicros: string; markToMarketEquityMicros: string; markToMarketReturnBps: string;
  liquidationValueEquityMicros: string; liquidationReturnBps: string; maxDrawdownBps: string;
  finalSignal: "BUY" | "HOLD" | "WAIT"; warnings: string[];
  coverage: { firstObservationMs: number; lastObservationMs: number; spanDays: number;
    expectedDailyIntervals: number; observedIntervals: number; missingDailyIntervals: number;
    gapCount: number; maximumGapDays: number; coverageBps: string };
  scenarios: ScenarioResult[];
  runManifest: { schemaVersion: "paper-backtest-run-manifest/v1";
    algorithmVersion: "sma-5-20-next-observation-v2";
    executionSemantics: "signal-from-prior-observations; execute-at-next-observation-price";
    priceFieldSemantics: "observation-price; not asserted to be market open";
    symbol: string; source: string; requestedWindowDays: number; retrievedAtMs?: number;
    datasetAsOfMs: number; inputSha256: string };
  endingEquityMicros: string; returnBps: string; inputHash: string;
  algorithmVersion: "sma-5-20-next-observation-v2"; asOfMs: number;
}

export const DEFAULT_BACKTEST_POLICY: BacktestPolicy = Object.freeze({
  initialCashMicros: 20_000_000n, allocationMicros: 2_000_000n,
  minimumReserveMicros: 10_000_000n, feeBps: 10n, slippageBps: 20n,
  fastWindow: 5, slowWindow: 20,
});
const DAY_MS = 86_400_000;
const SCENARIOS = [
  { name: "optimistic", feeBps: 5n, slippageBps: 10n, assumptions: "Illustrative low-friction case; not an observed execution quote." },
  { name: "base", feeBps: 10n, slippageBps: 20n, assumptions: "Illustrative default friction case; not an observed execution quote." },
  { name: "stress", feeBps: 25n, slippageBps: 50n, assumptions: "Illustrative higher-friction sensitivity case; not a worst-case bound." },
] as const;

function average(v: readonly HistoricalPrice[], end: number, n: number): bigint {
  let sum = 0n; for (let i = end - n + 1; i <= end; i++) sum += v[i]!.priceMicros;
  return sum / BigInt(n);
}
const ceilDiv = (v: bigint, d: bigint) => (v + d - 1n) / d;
const returns = (v: bigint, initial: bigint) => ((v - initial) * BPS_SCALE) / initial;
function buy(cash: bigint, price: bigint, p: BacktestPolicy) {
  const available = cash - p.minimumReserveMicros;
  const budget = available < p.allocationMicros ? available : p.allocationMicros;
  if (budget <= 0n) return { cash, quantity: 0n };
  const execution = ceilDiv(price * (BPS_SCALE + p.slippageBps), BPS_SCALE);
  const spendable = budget - ceilDiv(budget * p.feeBps, BPS_SCALE);
  const quantity = (spendable * ASSET_SCALE) / execution;
  const notional = ceilDiv(execution * quantity, ASSET_SCALE);
  const fee = ceilDiv(notional * p.feeBps, BPS_SCALE);
  return quantity > 0n && notional + fee <= budget
    ? { cash: cash - notional - fee, quantity } : { cash, quantity: 0n };
}
function liquidate(quantity: bigint, price: bigint, p: BacktestPolicy) {
  if (quantity <= 0n) return 0n;
  const execution = (price * (BPS_SCALE - p.slippageBps)) / BPS_SCALE;
  const notional = (execution * quantity) / ASSET_SCALE;
  return notional - ceilDiv(notional * p.feeBps, BPS_SCALE);
}
function coverage(input: readonly HistoricalPrice[]) {
  let gapCount = 0, missing = 0, maximumGapDays = 1;
  for (let i = 1; i < input.length; i++) {
    const days = Math.max(1, Math.round((input[i]!.observedAtMs - input[i - 1]!.observedAtMs) / DAY_MS));
    if (days > 1) { gapCount++; missing += days - 1; maximumGapDays = Math.max(maximumGapDays, days); }
  }
  const first = input[0]!.observedAtMs, last = input.at(-1)!.observedAtMs;
  const expected = Math.max(1, Math.round((last - first) / DAY_MS)), observed = input.length - 1;
  return { firstObservationMs: first, lastObservationMs: last, spanDays: expected,
    expectedDailyIntervals: expected, observedIntervals: observed, missingDailyIntervals: missing,
    gapCount, maximumGapDays, coverageBps: ((BigInt(observed) * BPS_SCALE) / BigInt(expected)).toString() };
}
function scenario(input: readonly HistoricalPrice[], policy: BacktestPolicy, s: typeof SCENARIOS[number]): ScenarioResult {
  const p = { ...policy, feeBps: s.feeBps, slippageBps: s.slippageBps };
  let cash = p.initialCashMicros, quantity = 0n, trades = 0, peak = cash, drawdown = 0n;
  for (let i = p.slowWindow; i < input.length; i++) {
    const bar = input[i]!, signalEnd = i - 1;
    const bullish = average(input, signalEnd, p.fastWindow) > average(input, signalEnd, p.slowWindow);
    if (bullish && quantity === 0n) {
      const fill = buy(cash, bar.priceMicros, p); cash = fill.cash; quantity = fill.quantity;
      if (quantity > 0n) trades++;
    } else if (!bullish && quantity > 0n) {
      cash += liquidate(quantity, bar.priceMicros, p); quantity = 0n; trades++;
    }
    const equity = cash + (bar.priceMicros * quantity) / ASSET_SCALE;
    if (equity > peak) peak = equity;
    const dd = peak > 0n ? ((peak - equity) * BPS_SCALE) / peak : 0n;
    if (dd > drawdown) drawdown = dd;
  }
  const last = input.at(-1)!.priceMicros;
  const mark = cash + (last * quantity) / ASSET_SCALE;
  const liquidation = cash + liquidate(quantity, last, p);
  const hold = buy(p.initialCashMicros, input[p.slowWindow]!.priceMicros, p);
  const holdMark = hold.cash + (last * hold.quantity) / ASSET_SCALE;
  const holdLiquidation = hold.cash + liquidate(hold.quantity, last, p);
  const liquidationBps = returns(liquidation, p.initialCashMicros);
  const holdLiquidationBps = returns(holdLiquidation, p.initialCashMicros);
  return { name: s.name, feeBps: p.feeBps.toString(), slippageBps: p.slippageBps.toString(),
    assumptions: s.assumptions, trades, roundTrips: Math.floor(trades / 2),
    markToMarketEquityMicros: mark.toString(), markToMarketReturnBps: returns(mark, p.initialCashMicros).toString(),
    liquidationValueEquityMicros: liquidation.toString(), liquidationReturnBps: liquidationBps.toString(),
    cashBenchmarkEquityMicros: p.initialCashMicros.toString(), cashBenchmarkReturnBps: "0",
    buyHoldMarkToMarketEquityMicros: holdMark.toString(),
    buyHoldMarkToMarketReturnBps: returns(holdMark, p.initialCashMicros).toString(),
    buyHoldLiquidationValueEquityMicros: holdLiquidation.toString(),
    buyHoldLiquidationReturnBps: holdLiquidationBps.toString(),
    netVsCashBps: liquidationBps.toString(), netVsBuyHoldBps: (liquidationBps - holdLiquidationBps).toString(),
    maxDrawdownBps: drawdown.toString() };
}

export function runPaperBacktest(
  input: readonly HistoricalPrice[], policy: BacktestPolicy = DEFAULT_BACKTEST_POLICY,
  context: BacktestContext = { symbol: "TEST", source: "fixture", windowDays: input.length },
): BacktestResult {
  if (!Number.isInteger(policy.fastWindow) || !Number.isInteger(policy.slowWindow) ||
      policy.fastWindow <= 0 || policy.slowWindow <= policy.fastWindow || input.length <= policy.slowWindow)
    throw new Error("BACKTEST_INSUFFICIENT_OR_INVALID_INPUT");
  if (policy.initialCashMicros <= 0n || policy.allocationMicros < 0n || policy.minimumReserveMicros < 0n ||
      policy.minimumReserveMicros > policy.initialCashMicros || policy.feeBps < 0n ||
      policy.feeBps >= BPS_SCALE || policy.slippageBps < 0n || policy.slippageBps >= BPS_SCALE)
    throw new Error("BACKTEST_INVALID_POLICY");
  if (!context.symbol.trim() || !context.source.trim() || !Number.isSafeInteger(context.windowDays) ||
      context.windowDays <= 0 || (context.retrievedAtMs !== undefined &&
      (!Number.isSafeInteger(context.retrievedAtMs) || context.retrievedAtMs <= 0)))
    throw new Error("BACKTEST_INVALID_CONTEXT");
  for (const [i, bar] of input.entries())
    if (!Number.isSafeInteger(bar.observedAtMs) || bar.observedAtMs <= 0 || bar.priceMicros <= 0n ||
        (i > 0 && bar.observedAtMs <= input[i - 1]!.observedAtMs))
      throw new Error("BACKTEST_INVALID_PRICE_SERIES");

  const algorithmVersion = "sma-5-20-next-observation-v2" as const;
  const normalized = { schemaVersion: "paper-backtest-run-manifest/v1", algorithmVersion,
    context: { symbol: context.symbol.trim().toUpperCase(), source: context.source.trim(),
      windowDays: context.windowDays, retrievedAtMs: context.retrievedAtMs ?? null },
    policy: { initialCashMicros: policy.initialCashMicros.toString(),
      allocationMicros: policy.allocationMicros.toString(),
      minimumReserveMicros: policy.minimumReserveMicros.toString(),
      fastWindow: policy.fastWindow, slowWindow: policy.slowWindow },
    scenarios: SCENARIOS.map(({ name, feeBps, slippageBps }) =>
      ({ name, feeBps: feeBps.toString(), slippageBps: slippageBps.toString() })),
    bars: input.map((bar) => [bar.observedAtMs, bar.priceMicros.toString()]) };
  const inputSha256 = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const scenarios = SCENARIOS.map((s) => scenario(input, policy, s));
  const base = scenarios[1]!;
  const decisionBars = input.length - policy.slowWindow;
  const warnings: string[] = [];
  if (decisionBars < 30) warnings.push(`LOW_DECISION_SAMPLE: only ${decisionBars} decision bars; fewer than 30.`);
  if (base.roundTrips < 5) warnings.push(`LOW_ROUND_TRIPS: only ${base.roundTrips} completed round trips in the base scenario; fewer than 5.`);
  if (base.trades % 2) warnings.push("OPEN_TERMINAL_POSITION: liquidation value includes an illustrative terminal exit with base friction.");
  const metrics = coverage(input);
  if (metrics.gapCount) warnings.push(`DATA_GAPS: ${metrics.gapCount} gaps contain ${metrics.missingDailyIntervals} missing daily intervals.`);
  const end = input.length - 1;
  const bullish = average(input, end, policy.fastWindow) > average(input, end, policy.slowWindow);
  const finalSignal: BacktestResult["finalSignal"] = bullish ? (base.trades % 2 ? "HOLD" : "BUY") : "WAIT";
  const last = input.at(-1)!;
  return { mode: "PAPER_BACKTEST", researchStatus: "UNVERIFIED_RESEARCH", bars: input.length,
    decisionBars, trades: base.trades, roundTrips: base.roundTrips,
    initialEquityMicros: policy.initialCashMicros.toString(),
    markToMarketEquityMicros: base.markToMarketEquityMicros,
    markToMarketReturnBps: base.markToMarketReturnBps,
    liquidationValueEquityMicros: base.liquidationValueEquityMicros,
    liquidationReturnBps: base.liquidationReturnBps, maxDrawdownBps: base.maxDrawdownBps,
    finalSignal, warnings, coverage: metrics, scenarios,
    runManifest: { schemaVersion: "paper-backtest-run-manifest/v1", algorithmVersion,
      executionSemantics: "signal-from-prior-observations; execute-at-next-observation-price",
      priceFieldSemantics: "observation-price; not asserted to be market open",
      symbol: context.symbol.trim().toUpperCase(), source: context.source.trim(),
      requestedWindowDays: context.windowDays,
      ...(context.retrievedAtMs === undefined ? {} : { retrievedAtMs: context.retrievedAtMs }),
      datasetAsOfMs: last.observedAtMs, inputSha256 },
    endingEquityMicros: base.liquidationValueEquityMicros, returnBps: base.liquidationReturnBps,
    inputHash: inputSha256, algorithmVersion, asOfMs: last.observedAtMs };
}
