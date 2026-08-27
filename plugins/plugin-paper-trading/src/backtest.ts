import { createHash } from "node:crypto";
import { ASSET_SCALE, BPS_SCALE } from "./types.js";

export interface HistoricalPrice {
  observedAtMs: number;
  priceMicros: bigint;
}
export interface BacktestContext {
  symbol: string;
  source: string;
  windowDays: number;
  retrievedAtMs?: number;
}
export interface BacktestPolicy {
  initialCashMicros: bigint;
  allocationMicros: bigint;
  minimumReserveMicros: bigint;
  feeBps: bigint;
  spreadBps: bigint;
  marketImpactBps: bigint;
  fastWindow: number;
  slowWindow: number;
}
export interface ScenarioResult {
  name: "optimistic" | "base" | "stress";
  feeBps: string;
  spreadBps: string;
  marketImpactBps: string;
  costProvenance: "illustrative-derived" | "illustrative-policy-input";
  assumptions: string;
  trades: number;
  roundTrips: number;
  markToMarketEquityMicros: string;
  markToMarketReturnBps: string;
  liquidationValueEquityMicros: string;
  liquidationReturnBps: string;
  cashBenchmarkEquityMicros: string;
  cashBenchmarkReturnBps: "0";
  buyHoldMarkToMarketEquityMicros: string;
  buyHoldMarkToMarketReturnBps: string;
  buyHoldLiquidationValueEquityMicros: string;
  buyHoldLiquidationReturnBps: string;
  netVsCashBps: string;
  netVsBuyHoldBps: string;
  profitabilityRanking: null;
  comparisonStatus: "NOT_RANKED_NO_OBSERVED_VENUE_BASIS";
  liquidationAdjustedMaxDrawdownBps: string;
  buyHoldLiquidationAdjustedMaxDrawdownBps: string;
}
export interface BacktestResult {
  mode: "PAPER_BACKTEST";
  researchStatus: "UNVERIFIED_RESEARCH";
  bars: number;
  decisionBars: number;
  trades: number;
  roundTrips: number;
  initialEquityMicros: string;
  markToMarketEquityMicros: string;
  markToMarketReturnBps: string;
  liquidationValueEquityMicros: string;
  liquidationReturnBps: string;
  maxDrawdownBps: string;
  finalSignal: "BUY" | "HOLD" | "WAIT";
  warnings: string[];
  coverage: {
    firstObservationMs: number;
    lastObservationMs: number;
    spanDays: number;
    expectedDailyIntervals: number;
    observedIntervals: number;
    missingDailyIntervals: number;
    gapCount: number;
    maximumGapDays: number;
    coverageBps: string;
  };
  scenarios: ScenarioResult[];
  runManifest: {
    schemaVersion: "paper-backtest-run-manifest/v2";
    algorithmVersion: "sma-5-20-next-observation-cost-model-v3";
    executionSemantics: "signal-from-prior-observations; execute-at-next-observation-price";
    priceFieldSemantics: "observation-price; not asserted to be market open";
    symbol: string;
    source: string;
    requestedWindowDays: number;
    retrievedAtMs?: number;
    datasetAsOfMs: number;
    inputSha256: string;
    venueBasis: "none-observed";
    profitabilityRankingPermitted: false;
    drawdownConvention: "liquidation-value-at-each-observation";
    costModel: Array<{
      name: string;
      feeBps: string;
      spreadBps: string;
      marketImpactBps: string;
      provenance: string;
    }>;
  };
  endingEquityMicros: string;
  returnBps: string;
  inputHash: string;
  algorithmVersion: "sma-5-20-next-observation-cost-model-v3";
  asOfMs: number;
}

export const DEFAULT_BACKTEST_POLICY: BacktestPolicy = Object.freeze({
  initialCashMicros: 20_000_000n,
  allocationMicros: 2_000_000n,
  minimumReserveMicros: 10_000_000n,
  feeBps: 10n,
  spreadBps: 10n,
  marketImpactBps: 10n,
  fastWindow: 5,
  slowWindow: 20,
});
const DAY_MS = 86_400_000;
function scenarios(policy: BacktestPolicy) {
  const scaled = (value: bigint, numerator: bigint, denominator: bigint) =>
    (value * numerator + denominator - 1n) / denominator;
  return [
    {
      name: "optimistic",
      feeBps: scaled(policy.feeBps, 1n, 2n),
      spreadBps: scaled(policy.spreadBps, 1n, 2n),
      marketImpactBps: scaled(policy.marketImpactBps, 1n, 2n),
      costProvenance: "illustrative-derived",
      assumptions:
        "Illustrative sensitivity at 0.5x base costs; no observed venue basis.",
    },
    {
      name: "base",
      feeBps: policy.feeBps,
      spreadBps: policy.spreadBps,
      marketImpactBps: policy.marketImpactBps,
      costProvenance: "illustrative-policy-input",
      assumptions:
        "Illustrative caller/default policy inputs; no observed venue basis.",
    },
    {
      name: "stress",
      feeBps: scaled(policy.feeBps, 5n, 2n),
      spreadBps: scaled(policy.spreadBps, 5n, 2n),
      marketImpactBps: scaled(policy.marketImpactBps, 5n, 2n),
      costProvenance: "illustrative-derived",
      assumptions:
        "Illustrative sensitivity at 2.5x base costs; not a worst-case bound and no observed venue basis.",
    },
  ] as const;
}

function average(
  v: readonly HistoricalPrice[],
  end: number,
  n: number,
): bigint {
  let sum = 0n;
  for (let i = end - n + 1; i <= end; i++) sum += requiredAt(v, i).priceMicros;
  return sum / BigInt(n);
}
function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values.at(index);
  if (value === undefined) throw new Error("BACKTEST_INTERNAL_INVARIANT");
  return value;
}
const ceilDiv = (v: bigint, d: bigint) => (v + d - 1n) / d;
const returns = (v: bigint, initial: bigint) =>
  ((v - initial) * BPS_SCALE) / initial;
function buy(cash: bigint, price: bigint, p: BacktestPolicy) {
  const available = cash - p.minimumReserveMicros;
  const budget =
    available < p.allocationMicros ? available : p.allocationMicros;
  if (budget <= 0n) return { cash, quantity: 0n };
  const executionCostBps = ceilDiv(p.spreadBps, 2n) + p.marketImpactBps;
  const execution = ceilDiv(price * (BPS_SCALE + executionCostBps), BPS_SCALE);
  const spendable = budget - ceilDiv(budget * p.feeBps, BPS_SCALE);
  const quantity = (spendable * ASSET_SCALE) / execution;
  const notional = ceilDiv(execution * quantity, ASSET_SCALE);
  const fee = ceilDiv(notional * p.feeBps, BPS_SCALE);
  return quantity > 0n && notional + fee <= budget
    ? { cash: cash - notional - fee, quantity }
    : { cash, quantity: 0n };
}
function liquidate(quantity: bigint, price: bigint, p: BacktestPolicy) {
  if (quantity <= 0n) return 0n;
  const executionCostBps = ceilDiv(p.spreadBps, 2n) + p.marketImpactBps;
  const execution = (price * (BPS_SCALE - executionCostBps)) / BPS_SCALE;
  const notional = (execution * quantity) / ASSET_SCALE;
  const fee = ceilDiv(notional * p.feeBps, BPS_SCALE);
  return fee >= notional ? 0n : notional - fee;
}
function coverage(input: readonly HistoricalPrice[]) {
  let gapCount = 0,
    missing = 0,
    maximumGapDays = 1;
  for (let i = 1; i < input.length; i++) {
    const current = requiredAt(input, i);
    const previous = requiredAt(input, i - 1);
    const days = Math.max(
      1,
      Math.round((current.observedAtMs - previous.observedAtMs) / DAY_MS),
    );
    if (days > 1) {
      gapCount++;
      missing += days - 1;
      maximumGapDays = Math.max(maximumGapDays, days);
    }
  }
  const first = requiredAt(input, 0).observedAtMs,
    last = requiredAt(input, -1).observedAtMs;
  const expected = Math.max(1, Math.round((last - first) / DAY_MS)),
    observed = input.length - 1;
  return {
    firstObservationMs: first,
    lastObservationMs: last,
    spanDays: expected,
    expectedDailyIntervals: expected,
    observedIntervals: observed,
    missingDailyIntervals: missing,
    gapCount,
    maximumGapDays,
    coverageBps: ((BigInt(observed) * BPS_SCALE) / BigInt(expected)).toString(),
  };
}
function scenario(
  input: readonly HistoricalPrice[],
  policy: BacktestPolicy,
  s: ReturnType<typeof scenarios>[number],
): ScenarioResult {
  const p = {
    ...policy,
    feeBps: s.feeBps,
    spreadBps: s.spreadBps,
    marketImpactBps: s.marketImpactBps,
  };
  let cash = p.initialCashMicros,
    quantity = 0n,
    trades = 0,
    peak = cash,
    drawdown = 0n;
  let holdPeak = p.initialCashMicros,
    holdDrawdown = 0n;
  const hold = buy(
    p.initialCashMicros,
    requiredAt(input, p.slowWindow).priceMicros,
    p,
  );
  for (let i = p.slowWindow; i < input.length; i++) {
    const bar = requiredAt(input, i),
      signalEnd = i - 1;
    const bullish =
      average(input, signalEnd, p.fastWindow) >
      average(input, signalEnd, p.slowWindow);
    if (bullish && quantity === 0n) {
      const fill = buy(cash, bar.priceMicros, p);
      cash = fill.cash;
      quantity = fill.quantity;
      if (quantity > 0n) trades++;
    } else if (!bullish && quantity > 0n) {
      cash += liquidate(quantity, bar.priceMicros, p);
      quantity = 0n;
      trades++;
    }
    // Drawdown uses a liquidation-adjusted path: each observation hypothetically
    // closes the position with that scenario's fee, half-spread, and impact.
    const equity = cash + liquidate(quantity, bar.priceMicros, p);
    if (equity > peak) peak = equity;
    const dd = peak > 0n ? ((peak - equity) * BPS_SCALE) / peak : 0n;
    if (dd > drawdown) drawdown = dd;
    const holdEquity = hold.cash + liquidate(hold.quantity, bar.priceMicros, p);
    if (holdEquity > holdPeak) holdPeak = holdEquity;
    const holdDd =
      holdPeak > 0n ? ((holdPeak - holdEquity) * BPS_SCALE) / holdPeak : 0n;
    if (holdDd > holdDrawdown) holdDrawdown = holdDd;
  }
  const last = requiredAt(input, -1).priceMicros;
  const mark = cash + (last * quantity) / ASSET_SCALE;
  const liquidation = cash + liquidate(quantity, last, p);
  const holdMark = hold.cash + (last * hold.quantity) / ASSET_SCALE;
  const holdLiquidation = hold.cash + liquidate(hold.quantity, last, p);
  const liquidationBps = returns(liquidation, p.initialCashMicros);
  const holdLiquidationBps = returns(holdLiquidation, p.initialCashMicros);
  return {
    name: s.name,
    feeBps: p.feeBps.toString(),
    spreadBps: p.spreadBps.toString(),
    marketImpactBps: p.marketImpactBps.toString(),
    costProvenance: s.costProvenance,
    assumptions: s.assumptions,
    trades,
    roundTrips: Math.floor(trades / 2),
    markToMarketEquityMicros: mark.toString(),
    markToMarketReturnBps: returns(mark, p.initialCashMicros).toString(),
    liquidationValueEquityMicros: liquidation.toString(),
    liquidationReturnBps: liquidationBps.toString(),
    cashBenchmarkEquityMicros: p.initialCashMicros.toString(),
    cashBenchmarkReturnBps: "0",
    buyHoldMarkToMarketEquityMicros: holdMark.toString(),
    buyHoldMarkToMarketReturnBps: returns(
      holdMark,
      p.initialCashMicros,
    ).toString(),
    buyHoldLiquidationValueEquityMicros: holdLiquidation.toString(),
    buyHoldLiquidationReturnBps: holdLiquidationBps.toString(),
    netVsCashBps: liquidationBps.toString(),
    netVsBuyHoldBps: (liquidationBps - holdLiquidationBps).toString(),
    profitabilityRanking: null,
    comparisonStatus: "NOT_RANKED_NO_OBSERVED_VENUE_BASIS",
    liquidationAdjustedMaxDrawdownBps: drawdown.toString(),
    buyHoldLiquidationAdjustedMaxDrawdownBps: holdDrawdown.toString(),
  };
}

export function runPaperBacktest(
  input: readonly HistoricalPrice[],
  policy: BacktestPolicy = DEFAULT_BACKTEST_POLICY,
  context: BacktestContext = {
    symbol: "TEST",
    source: "fixture",
    windowDays: input.length,
  },
): BacktestResult {
  if (
    !Number.isInteger(policy.fastWindow) ||
    !Number.isInteger(policy.slowWindow) ||
    policy.fastWindow <= 0 ||
    policy.slowWindow <= policy.fastWindow ||
    input.length <= policy.slowWindow
  )
    throw new Error("BACKTEST_INSUFFICIENT_OR_INVALID_INPUT");
  const stressFeeBps = ceilDiv(policy.feeBps * 5n, 2n);
  const stressSpreadBps = ceilDiv(policy.spreadBps * 5n, 2n);
  const stressMarketImpactBps = ceilDiv(policy.marketImpactBps * 5n, 2n);
  if (
    policy.initialCashMicros <= 0n ||
    policy.allocationMicros < 0n ||
    policy.minimumReserveMicros < 0n ||
    policy.minimumReserveMicros > policy.initialCashMicros ||
    policy.feeBps < 0n ||
    policy.feeBps >= BPS_SCALE ||
    policy.spreadBps < 0n ||
    policy.spreadBps >= BPS_SCALE ||
    policy.marketImpactBps < 0n ||
    policy.marketImpactBps >= BPS_SCALE ||
    ceilDiv(policy.spreadBps, 2n) + policy.marketImpactBps >= BPS_SCALE ||
    stressFeeBps >= BPS_SCALE ||
    ceilDiv(stressSpreadBps, 2n) + stressMarketImpactBps >= BPS_SCALE
  )
    throw new Error("BACKTEST_INVALID_POLICY");
  if (
    !context.symbol.trim() ||
    !context.source.trim() ||
    !Number.isSafeInteger(context.windowDays) ||
    context.windowDays <= 0 ||
    (context.retrievedAtMs !== undefined &&
      (!Number.isSafeInteger(context.retrievedAtMs) ||
        context.retrievedAtMs <= 0))
  )
    throw new Error("BACKTEST_INVALID_CONTEXT");
  for (const [i, bar] of input.entries())
    if (
      !Number.isSafeInteger(bar.observedAtMs) ||
      bar.observedAtMs <= 0 ||
      bar.priceMicros <= 0n ||
      (i > 0 && bar.observedAtMs <= requiredAt(input, i - 1).observedAtMs)
    )
      throw new Error("BACKTEST_INVALID_PRICE_SERIES");

  const algorithmVersion = "sma-5-20-next-observation-cost-model-v3" as const;
  const normalized = {
    schemaVersion: "paper-backtest-run-manifest/v2",
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
      requestedFeeBps: policy.feeBps.toString(),
      requestedSpreadBps: policy.spreadBps.toString(),
      requestedMarketImpactBps: policy.marketImpactBps.toString(),
      fastWindow: policy.fastWindow,
      slowWindow: policy.slowWindow,
    },
    scenarios: scenarios(policy).map(
      ({
        name,
        feeBps,
        spreadBps,
        marketImpactBps,
        costProvenance,
        assumptions,
      }) => ({
        name,
        feeBps: feeBps.toString(),
        spreadBps: spreadBps.toString(),
        marketImpactBps: marketImpactBps.toString(),
        costProvenance,
        assumptions,
      }),
    ),
    bars: input.map((bar) => [bar.observedAtMs, bar.priceMicros.toString()]),
  };
  const inputSha256 = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const scenarioResults = scenarios(policy).map((s) =>
    scenario(input, policy, s),
  );
  const base = requiredAt(scenarioResults, 1);
  const decisionBars = input.length - policy.slowWindow;
  const warnings: string[] = [];
  if (decisionBars < 30)
    warnings.push(
      `LOW_DECISION_SAMPLE: only ${decisionBars} decision bars; fewer than 30.`,
    );
  if (base.roundTrips < 5)
    warnings.push(
      `LOW_ROUND_TRIPS: only ${base.roundTrips} completed round trips in the base scenario; fewer than 5.`,
    );
  if (base.trades % 2)
    warnings.push(
      "OPEN_TERMINAL_POSITION: liquidation value includes an illustrative terminal exit with base friction.",
    );
  const metrics = coverage(input);
  if (metrics.gapCount)
    warnings.push(
      `DATA_GAPS: ${metrics.gapCount} gaps contain ${metrics.missingDailyIntervals} missing daily intervals.`,
    );
  const end = input.length - 1;
  const bullish =
    average(input, end, policy.fastWindow) >
    average(input, end, policy.slowWindow);
  const finalSignal: BacktestResult["finalSignal"] = bullish
    ? base.trades % 2
      ? "HOLD"
      : "BUY"
    : "WAIT";
  const last = requiredAt(input, -1);
  return {
    mode: "PAPER_BACKTEST",
    researchStatus: "UNVERIFIED_RESEARCH",
    bars: input.length,
    decisionBars,
    trades: base.trades,
    roundTrips: base.roundTrips,
    initialEquityMicros: policy.initialCashMicros.toString(),
    markToMarketEquityMicros: base.markToMarketEquityMicros,
    markToMarketReturnBps: base.markToMarketReturnBps,
    liquidationValueEquityMicros: base.liquidationValueEquityMicros,
    liquidationReturnBps: base.liquidationReturnBps,
    maxDrawdownBps: base.liquidationAdjustedMaxDrawdownBps,
    finalSignal,
    warnings,
    coverage: metrics,
    scenarios: scenarioResults,
    runManifest: {
      schemaVersion: "paper-backtest-run-manifest/v2",
      algorithmVersion,
      executionSemantics:
        "signal-from-prior-observations; execute-at-next-observation-price",
      priceFieldSemantics: "observation-price; not asserted to be market open",
      symbol: context.symbol.trim().toUpperCase(),
      source: context.source.trim(),
      requestedWindowDays: context.windowDays,
      ...(context.retrievedAtMs === undefined
        ? {}
        : { retrievedAtMs: context.retrievedAtMs }),
      datasetAsOfMs: last.observedAtMs,
      inputSha256,
      venueBasis: "none-observed",
      profitabilityRankingPermitted: false,
      drawdownConvention: "liquidation-value-at-each-observation",
      costModel: scenarios(policy).map((item) => ({
        name: item.name,
        feeBps: item.feeBps.toString(),
        spreadBps: item.spreadBps.toString(),
        marketImpactBps: item.marketImpactBps.toString(),
        provenance: item.costProvenance,
      })),
    },
    endingEquityMicros: base.liquidationValueEquityMicros,
    returnBps: base.liquidationReturnBps,
    inputHash: inputSha256,
    algorithmVersion,
    asOfMs: last.observedAtMs,
  };
}
