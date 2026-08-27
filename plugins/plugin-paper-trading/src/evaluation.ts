import { createHash } from "node:crypto";
import {
  type BacktestContext,
  type BacktestResult,
  type HistoricalPrice,
  runPaperBacktest,
} from "./backtest.js";
import { BPS_SCALE } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVALUATION_BARS = 2_000;
export const MAX_WALK_FORWARD_FOLDS = 128;
const WALK_FORWARD_ALGORITHM_VERSION = "fixed-sma-walk-forward-oos-v1" as const;

export interface PaperWalkForwardPolicy {
  initialCashMicros: bigint;
  allocationMicros: bigint;
  minimumReserveMicros: bigint;
  feeBps: bigint;
  spreadBps: bigint;
  slippageBps: bigint;
  liquidityBps: bigint;
  fastWindow: number;
  slowWindow: number;
}

export interface PaperWalkForwardProtocol {
  schemaVersion: "paper-walk-forward-protocol/v1";
  initialTrainingBars: number;
  validationBars: number;
  outOfSampleBars: number;
}

export interface PaperWalkForwardConfigurationSeed {
  protocol: PaperWalkForwardProtocol;
  policy: PaperWalkForwardPolicy;
  expectedDatasetSha256: string;
}

export interface PaperWalkForwardOptions
  extends PaperWalkForwardConfigurationSeed {
  expectedConfigurationSha256: string;
}

interface SerializedWalkForwardPolicy {
  initialCashMicros: string;
  allocationMicros: string;
  minimumReserveMicros: string;
  feeBps: string;
  spreadBps: string;
  slippageBps: string;
  liquidityBps: string;
  fastWindow: number;
  slowWindow: number;
}

export interface PaperEvaluationWindow {
  startIndex: number;
  endIndexExclusive: number;
  evaluationBars: number;
  warmupBars: number;
  firstEvaluationObservationMs: number;
  lastEvaluationObservationMs: number;
  result: BacktestResult;
}

export interface PaperWalkForwardFold {
  fold: number;
  training: PaperEvaluationWindow;
  validation: PaperEvaluationWindow;
}

export interface PaperWalkForwardEvaluationResult {
  mode: "PAPER_WALK_FORWARD_EVALUATION";
  researchStatus: "UNVERIFIED_RESEARCH";
  algorithmVersion: "fixed-sma-walk-forward-oos-v1";
  selectionMethod: "CALLER_PINNED_CONFIGURATION_NO_INTERNAL_TUNING";
  holdoutStatus: "OOS_EVALUATED_ONLY_AFTER_PINNED_DEVELOPMENT_FOLDS";
  dataset: {
    schemaVersion: "paper-public-historical-dataset/v1";
    symbol: string;
    source: string;
    requestedWindowDays: number;
    bars: number;
    firstObservationMs: number;
    lastObservationMs: number;
    datasetAsOfMs: number;
    retrievedAtMs?: number;
    sha256: string;
  };
  configuration: {
    schemaVersion: "paper-walk-forward-configuration/v1";
    algorithmVersion: "fixed-sma-walk-forward-oos-v1";
    expectedDatasetSha256: string;
    scenarioMultipliers: {
      optimistic: "0.5";
      base: "1";
      stress: "2.5";
    };
    protocol: PaperWalkForwardProtocol;
    policy: SerializedWalkForwardPolicy;
  };
  configurationSha256: string;
  configurationCommitmentStatus: "VERIFIED_PRECOMMITTED_SHA256";
  frictionScenarios: readonly PaperEvaluationFrictionScenario[];
  folds: readonly PaperWalkForwardFold[];
  outOfSample: PaperEvaluationWindow;
  evaluationSha256: string;
}

export interface PaperEvaluationFrictionScenario {
  name: "optimistic" | "base" | "stress";
  feeBps: string;
  spreadBps: string;
  slippageBps: string;
  liquidityBps: string;
  combinedMarketImpactBps: string;
  provenance: "illustrative-derived" | "illustrative-policy-input";
}

export const DEFAULT_WALK_FORWARD_POLICY: PaperWalkForwardPolicy =
  Object.freeze({
    initialCashMicros: 20_000_000n,
    allocationMicros: 2_000_000n,
    minimumReserveMicros: 10_000_000n,
    feeBps: 10n,
    spreadBps: 10n,
    slippageBps: 5n,
    liquidityBps: 5n,
    fastWindow: 5,
    slowWindow: 20,
  });

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateContext(context: BacktestContext): void {
  if (
    !context ||
    typeof context.symbol !== "string" ||
    !context.symbol.trim() ||
    typeof context.source !== "string" ||
    !context.source.trim() ||
    !Number.isSafeInteger(context.windowDays) ||
    context.windowDays <= 0 ||
    (context.retrievedAtMs !== undefined &&
      (!Number.isSafeInteger(context.retrievedAtMs) ||
        context.retrievedAtMs <= 0))
  ) {
    throw new Error("WALK_FORWARD_INVALID_CONTEXT");
  }
}

function validateSeries(input: readonly HistoricalPrice[]): void {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_EVALUATION_BARS
  ) {
    throw new Error("WALK_FORWARD_INVALID_PRICE_SERIES");
  }
  let previousObservedAtMs: number | undefined;
  for (const [index, bar] of input.entries()) {
    if (
      !bar ||
      !Number.isSafeInteger(bar.observedAtMs) ||
      bar.observedAtMs <= 0 ||
      typeof bar.priceMicros !== "bigint" ||
      bar.priceMicros <= 0n ||
      (index > 0 &&
        previousObservedAtMs !== undefined &&
        bar.observedAtMs <= previousObservedAtMs)
    ) {
      throw new Error("WALK_FORWARD_INVALID_PRICE_SERIES");
    }
    previousObservedAtMs = bar.observedAtMs;
  }
}

function snapshotSeries(
  input: readonly HistoricalPrice[],
): readonly HistoricalPrice[] {
  if (!Array.isArray(input) || input.length > MAX_EVALUATION_BARS) {
    throw new Error("WALK_FORWARD_INVALID_PRICE_SERIES");
  }
  const snapshot = input.map((bar) => {
    if (!bar || typeof bar !== "object") {
      throw new Error("WALK_FORWARD_INVALID_PRICE_SERIES");
    }
    return Object.freeze({
      observedAtMs: bar.observedAtMs,
      priceMicros: bar.priceMicros,
    });
  });
  validateSeries(snapshot);
  return Object.freeze(snapshot);
}

function validateTemporalProvenance(
  input: readonly HistoricalPrice[],
  context: BacktestContext,
): void {
  const last = input.at(-1);
  if (
    !last ||
    (context.retrievedAtMs !== undefined &&
      last.observedAtMs > context.retrievedAtMs)
  ) {
    throw new Error("WALK_FORWARD_INVALID_CONTEXT");
  }
}

function normalizedDataset(
  input: readonly HistoricalPrice[],
  context: BacktestContext,
): unknown {
  return {
    schemaVersion: "paper-public-historical-dataset/v1",
    symbol: context.symbol.trim().toUpperCase(),
    source: context.source.trim(),
    requestedWindowDays: context.windowDays,
    bars: input.map((bar) => [bar.observedAtMs, bar.priceMicros.toString()]),
  };
}

export function hashPublicHistoricalDataset(
  input: readonly HistoricalPrice[],
  context: BacktestContext,
): string {
  validateContext(context);
  const snapshot = snapshotSeries(input);
  validateTemporalProvenance(snapshot, context);
  return sha256(normalizedDataset(snapshot, context));
}

function normalizePolicy(
  policy: PaperWalkForwardPolicy,
): SerializedWalkForwardPolicy {
  if (!policy || typeof policy !== "object") {
    throw new Error("WALK_FORWARD_INVALID_POLICY");
  }
  const bigintFields = [
    "initialCashMicros",
    "allocationMicros",
    "minimumReserveMicros",
    "feeBps",
    "spreadBps",
    "slippageBps",
    "liquidityBps",
  ] as const;
  if (
    bigintFields.some((field) => typeof policy[field] !== "bigint") ||
    !Number.isInteger(policy.fastWindow) ||
    !Number.isInteger(policy.slowWindow)
  ) {
    throw new Error("WALK_FORWARD_INVALID_POLICY");
  }

  const executionImpactBps = policy.slippageBps + policy.liquidityBps;
  const stressFeeBps = ceilDiv(policy.feeBps * 5n, 2n);
  const stressSpreadBps = ceilDiv(policy.spreadBps * 5n, 2n);
  const stressExecutionImpactBps = ceilDiv(executionImpactBps * 5n, 2n);
  if (
    policy.initialCashMicros <= 0n ||
    policy.allocationMicros < 0n ||
    policy.minimumReserveMicros < 0n ||
    policy.minimumReserveMicros > policy.initialCashMicros ||
    policy.feeBps < 0n ||
    policy.spreadBps < 0n ||
    policy.slippageBps < 0n ||
    policy.liquidityBps < 0n ||
    policy.feeBps >= BPS_SCALE ||
    policy.spreadBps >= BPS_SCALE ||
    executionImpactBps >= BPS_SCALE ||
    ceilDiv(policy.spreadBps, 2n) + executionImpactBps >= BPS_SCALE ||
    stressFeeBps >= BPS_SCALE ||
    ceilDiv(stressSpreadBps, 2n) + stressExecutionImpactBps >= BPS_SCALE ||
    policy.fastWindow <= 0 ||
    policy.slowWindow <= policy.fastWindow ||
    policy.fastWindow !== 5 ||
    policy.slowWindow !== 20
  ) {
    throw new Error("WALK_FORWARD_INVALID_POLICY");
  }

  return {
    initialCashMicros: policy.initialCashMicros.toString(),
    allocationMicros: policy.allocationMicros.toString(),
    minimumReserveMicros: policy.minimumReserveMicros.toString(),
    feeBps: policy.feeBps.toString(),
    spreadBps: policy.spreadBps.toString(),
    slippageBps: policy.slippageBps.toString(),
    liquidityBps: policy.liquidityBps.toString(),
    fastWindow: policy.fastWindow,
    slowWindow: policy.slowWindow,
  };
}

function frictionScenarios(
  policy: PaperWalkForwardPolicy,
): PaperEvaluationFrictionScenario[] {
  const scale = (
    name: PaperEvaluationFrictionScenario["name"],
    numerator: bigint,
    denominator: bigint,
    provenance: PaperEvaluationFrictionScenario["provenance"],
  ): PaperEvaluationFrictionScenario => {
    const combinedMarketImpactBps = ceilDiv(
      (policy.slippageBps + policy.liquidityBps) * numerator,
      denominator,
    );
    const slippageBps = ceilDiv(policy.slippageBps * numerator, denominator);
    const liquidityBps = combinedMarketImpactBps - slippageBps;
    return {
      name,
      feeBps: ceilDiv(policy.feeBps * numerator, denominator).toString(),
      spreadBps: ceilDiv(policy.spreadBps * numerator, denominator).toString(),
      slippageBps: slippageBps.toString(),
      liquidityBps: liquidityBps.toString(),
      combinedMarketImpactBps: combinedMarketImpactBps.toString(),
      provenance,
    };
  };
  return [
    scale("optimistic", 1n, 2n, "illustrative-derived"),
    scale("base", 1n, 1n, "illustrative-policy-input"),
    scale("stress", 5n, 2n, "illustrative-derived"),
  ];
}

function validateProtocol(
  protocol: PaperWalkForwardProtocol,
  inputLength: number,
  slowWindow: number,
): number {
  if (!protocol) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }
  if (
    protocol.schemaVersion !== "paper-walk-forward-protocol/v1" ||
    !Number.isSafeInteger(protocol.initialTrainingBars) ||
    !Number.isSafeInteger(protocol.validationBars) ||
    !Number.isSafeInteger(protocol.outOfSampleBars) ||
    protocol.initialTrainingBars <= slowWindow ||
    protocol.validationBars <= 0 ||
    protocol.outOfSampleBars <= 0
  ) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }

  const developmentEnd = inputLength - protocol.outOfSampleBars;
  const developmentValidationBars =
    developmentEnd - protocol.initialTrainingBars;
  if (
    developmentValidationBars < protocol.validationBars ||
    developmentValidationBars % protocol.validationBars !== 0
  ) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }
  const foldCount = developmentValidationBars / protocol.validationBars;
  if (foldCount > MAX_WALK_FORWARD_FOLDS) {
    throw new Error("WALK_FORWARD_TOO_MANY_FOLDS");
  }
  return developmentEnd;
}

function prepareConfiguration(
  inputLength: number,
  seed: PaperWalkForwardConfigurationSeed,
) {
  if (
    !Number.isSafeInteger(inputLength) ||
    inputLength <= 0 ||
    inputLength > MAX_EVALUATION_BARS ||
    !seed ||
    !SHA256.test(seed.expectedDatasetSha256)
  ) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }
  const serializedPolicy = normalizePolicy(seed.policy);
  const developmentEnd = validateProtocol(
    seed.protocol,
    inputLength,
    seed.policy.slowWindow,
  );
  const configuration = {
    schemaVersion: "paper-walk-forward-configuration/v1" as const,
    algorithmVersion: WALK_FORWARD_ALGORITHM_VERSION,
    expectedDatasetSha256: seed.expectedDatasetSha256,
    scenarioMultipliers: {
      optimistic: "0.5" as const,
      base: "1" as const,
      stress: "2.5" as const,
    },
    protocol: {
      schemaVersion: seed.protocol.schemaVersion,
      initialTrainingBars: seed.protocol.initialTrainingBars,
      validationBars: seed.protocol.validationBars,
      outOfSampleBars: seed.protocol.outOfSampleBars,
    },
    policy: serializedPolicy,
  };
  return {
    configuration,
    configurationSha256: sha256(configuration),
    developmentEnd,
  };
}

export function hashPaperWalkForwardConfiguration(
  inputLength: number,
  seed: PaperWalkForwardConfigurationSeed,
): string {
  return prepareConfiguration(inputLength, seed).configurationSha256;
}

function toBacktestPolicy(policy: PaperWalkForwardPolicy) {
  return {
    initialCashMicros: policy.initialCashMicros,
    allocationMicros: policy.allocationMicros,
    minimumReserveMicros: policy.minimumReserveMicros,
    feeBps: policy.feeBps,
    spreadBps: policy.spreadBps,
    marketImpactBps: policy.slippageBps + policy.liquidityBps,
    fastWindow: policy.fastWindow,
    slowWindow: policy.slowWindow,
  };
}

function evaluationContext(
  context: BacktestContext,
  windowDays: number,
): BacktestContext {
  return {
    symbol: context.symbol.trim().toUpperCase(),
    source: context.source.trim(),
    windowDays,
    ...(context.retrievedAtMs === undefined
      ? {}
      : { retrievedAtMs: context.retrievedAtMs }),
  };
}

function evaluateWindow(
  input: readonly HistoricalPrice[],
  startIndex: number,
  endIndexExclusive: number,
  warmupBars: number,
  policy: PaperWalkForwardPolicy,
  context: BacktestContext,
): PaperEvaluationWindow {
  const inputStart = startIndex - warmupBars;
  if (inputStart < 0 || endIndexExclusive > input.length) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }
  const evaluationBars = endIndexExclusive - startIndex;
  const prices = input.slice(inputStart, endIndexExclusive).map((bar) => ({
    observedAtMs: bar.observedAtMs,
    priceMicros: bar.priceMicros,
  }));
  const result = runPaperBacktest(
    prices,
    toBacktestPolicy(policy),
    evaluationContext(context, evaluationBars),
  );
  const firstEvaluation = input[startIndex];
  const lastEvaluation = input[endIndexExclusive - 1];
  if (!firstEvaluation || !lastEvaluation) {
    throw new Error("WALK_FORWARD_INVALID_SPLIT");
  }
  return {
    startIndex,
    endIndexExclusive,
    evaluationBars,
    warmupBars,
    firstEvaluationObservationMs: firstEvaluation.observedAtMs,
    lastEvaluationObservationMs: lastEvaluation.observedAtMs,
    result,
  };
}

export function runPaperWalkForwardEvaluation(
  input: readonly HistoricalPrice[],
  context: BacktestContext,
  options: PaperWalkForwardOptions,
): PaperWalkForwardEvaluationResult {
  validateContext(context);
  const snapshot = snapshotSeries(input);
  validateTemporalProvenance(snapshot, context);
  if (!options || !SHA256.test(options.expectedDatasetSha256)) {
    throw new Error("WALK_FORWARD_DATASET_CHECKSUM_MISMATCH");
  }

  const datasetSha256 = sha256(normalizedDataset(snapshot, context));
  if (datasetSha256 !== options.expectedDatasetSha256) {
    throw new Error("WALK_FORWARD_DATASET_CHECKSUM_MISMATCH");
  }
  const { configuration, configurationSha256, developmentEnd } =
    prepareConfiguration(snapshot.length, options);
  if (
    !SHA256.test(options.expectedConfigurationSha256) ||
    options.expectedConfigurationSha256 !== configurationSha256
  ) {
    throw new Error("WALK_FORWARD_CONFIGURATION_CHECKSUM_MISMATCH");
  }
  const folds: PaperWalkForwardFold[] = [];
  for (
    let validationStart = options.protocol.initialTrainingBars, fold = 1;
    validationStart < developmentEnd;
    validationStart += options.protocol.validationBars, fold += 1
  ) {
    const validationEnd = validationStart + options.protocol.validationBars;
    folds.push({
      fold,
      training: evaluateWindow(
        snapshot,
        0,
        validationStart,
        0,
        options.policy,
        context,
      ),
      validation: evaluateWindow(
        snapshot,
        validationStart,
        validationEnd,
        options.policy.slowWindow,
        options.policy,
        context,
      ),
    });
  }

  // The holdout is deliberately evaluated only after every development fold
  // has completed. No configuration selection or fitting occurs in this API.
  const outOfSample = evaluateWindow(
    snapshot,
    developmentEnd,
    snapshot.length,
    options.policy.slowWindow,
    options.policy,
    context,
  );
  const first = snapshot[0];
  const last = snapshot.at(-1);
  if (!first || !last) {
    throw new Error("WALK_FORWARD_INVALID_PRICE_SERIES");
  }
  const draft = {
    mode: "PAPER_WALK_FORWARD_EVALUATION" as const,
    researchStatus: "UNVERIFIED_RESEARCH" as const,
    algorithmVersion: WALK_FORWARD_ALGORITHM_VERSION,
    selectionMethod: "CALLER_PINNED_CONFIGURATION_NO_INTERNAL_TUNING" as const,
    holdoutStatus: "OOS_EVALUATED_ONLY_AFTER_PINNED_DEVELOPMENT_FOLDS" as const,
    dataset: {
      schemaVersion: "paper-public-historical-dataset/v1" as const,
      symbol: context.symbol.trim().toUpperCase(),
      source: context.source.trim(),
      requestedWindowDays: context.windowDays,
      bars: snapshot.length,
      firstObservationMs: first.observedAtMs,
      lastObservationMs: last.observedAtMs,
      datasetAsOfMs: last.observedAtMs,
      ...(context.retrievedAtMs === undefined
        ? {}
        : { retrievedAtMs: context.retrievedAtMs }),
      sha256: datasetSha256,
    },
    configuration,
    configurationSha256,
    configurationCommitmentStatus: "VERIFIED_PRECOMMITTED_SHA256" as const,
    frictionScenarios: frictionScenarios(options.policy),
    folds,
    outOfSample,
  };
  return deepFreeze({ ...draft, evaluationSha256: sha256(draft) });
}
