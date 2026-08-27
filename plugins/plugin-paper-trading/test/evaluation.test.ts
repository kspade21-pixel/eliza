import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALK_FORWARD_POLICY,
  type HistoricalPrice,
  hashPaperWalkForwardConfiguration,
  hashPublicHistoricalDataset,
  PaperTradingEngine,
  runPaperWalkForwardEvaluation,
} from "../src/index.js";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 0, 1);

function fixture(): readonly HistoricalPrice[] {
  return Object.freeze(
    Array.from({ length: 140 }, (_, index) => {
      const phase = index % 28;
      const triangular = phase <= 14 ? phase : 28 - phase;
      return Object.freeze({
        observedAtMs: START_MS + index * DAY_MS,
        priceMicros:
          40_000_000_000n +
          BigInt(index) * 25_000_000n +
          BigInt(triangular) * 180_000_000n,
      });
    }),
  );
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

const context = {
  symbol: "BTC",
  source: "public.example.test/immutable/btc-usd-daily-v1.json",
  windowDays: 140,
  retrievedAtMs: Date.UTC(2026, 5, 1),
} as const;

const protocol = {
  schemaVersion: "paper-walk-forward-protocol/v1",
  initialTrainingBars: 60,
  validationBars: 20,
  outOfSampleBars: 20,
} as const;

function evaluationOptions(
  input: readonly HistoricalPrice[],
  policy = DEFAULT_WALK_FORWARD_POLICY,
  selectedProtocol = protocol,
) {
  const seed = {
    protocol: selectedProtocol,
    policy,
    expectedDatasetSha256: hashPublicHistoricalDataset(input, context),
  } as const;
  return {
    ...seed,
    expectedConfigurationSha256: hashPaperWalkForwardConfiguration(
      input.length,
      seed,
    ),
  };
}

describe("paper walk-forward evaluation", () => {
  it("hashes and pins the exact normalized public dataset", () => {
    const input = fixture();
    const hash = hashPublicHistoricalDataset(input, context);
    const options = evaluationOptions(input);

    expect(hash).toBe(
      "e145f20c2950b442d399baee0c9adbec498e18adedd9657ff733704892a4ac28",
    );
    expect(() =>
      runPaperWalkForwardEvaluation(input, context, {
        ...options,
        expectedDatasetSha256: "0".repeat(64),
      }),
    ).toThrow("WALK_FORWARD_DATASET_CHECKSUM_MISMATCH");
  });

  it("uses expanding chronological folds and evaluates the untouched holdout last", () => {
    const input = fixture();
    const expectedDatasetSha256 = hashPublicHistoricalDataset(input, context);
    const options = evaluationOptions(input);

    const first = runPaperWalkForwardEvaluation(input, context, options);
    const second = runPaperWalkForwardEvaluation(input, context, options);

    expect(first).toEqual(second);
    expect(first.mode).toBe("PAPER_WALK_FORWARD_EVALUATION");
    expect(first.researchStatus).toBe("UNVERIFIED_RESEARCH");
    expect(first.selectionMethod).toBe(
      "CALLER_PINNED_CONFIGURATION_NO_INTERNAL_TUNING",
    );
    expect(first.holdoutStatus).toBe(
      "OOS_EVALUATED_ONLY_AFTER_PINNED_DEVELOPMENT_FOLDS",
    );
    expect(first.configurationCommitmentStatus).toBe(
      "VERIFIED_PRECOMMITTED_SHA256",
    );
    expect(
      first.folds.map((fold) => [
        fold.training.startIndex,
        fold.training.endIndexExclusive,
        fold.validation.startIndex,
        fold.validation.endIndexExclusive,
      ]),
    ).toEqual([
      [0, 60, 60, 80],
      [0, 80, 80, 100],
      [0, 100, 100, 120],
    ]);
    expect(
      first.folds.every(
        (fold) =>
          fold.validation.endIndexExclusive <= first.outOfSample.startIndex,
      ),
    ).toBe(true);
    expect(first.outOfSample).toMatchObject({
      startIndex: 120,
      endIndexExclusive: 140,
      evaluationBars: 20,
      warmupBars: 20,
    });
    expect(first.dataset.sha256).toBe(expectedDatasetSha256);
    expect(first.configurationSha256).toBe(
      "51ec1f715754be69222796e370f28f0b41075d86c86642b1226606639257a0d6",
    );
    expect(first.evaluationSha256).toBe(
      "82becc8716217760ac5c4b8862d1a03dd903ffb832d49f60ba777923f2c4b98e",
    );
    expect(
      first.outOfSample.result.scenarios.map((scenario) => ({
        name: scenario.name,
        liquidationReturnBps: scenario.liquidationReturnBps,
        buyHoldLiquidationReturnBps: scenario.buyHoldLiquidationReturnBps,
      })),
    ).toEqual([
      {
        name: "optimistic",
        liquidationReturnBps: "-9",
        buyHoldLiquidationReturnBps: "-20",
      },
      {
        name: "base",
        liquidationReturnBps: "-12",
        buyHoldLiquidationReturnBps: "-22",
      },
      {
        name: "stress",
        liquidationReturnBps: "-19",
        buyHoldLiquidationReturnBps: "-29",
      },
    ]);
  });

  it("keeps fee, spread, slippage, and liquidity assumptions separate", () => {
    const input = fixture();
    const policy = {
      ...DEFAULT_WALK_FORWARD_POLICY,
      feeBps: 12n,
      spreadBps: 18n,
      slippageBps: 7n,
      liquidityBps: 11n,
    };
    const result = runPaperWalkForwardEvaluation(
      input,
      context,
      evaluationOptions(input, policy),
    );

    expect(result.configuration.policy).toMatchObject({
      feeBps: "12",
      spreadBps: "18",
      slippageBps: "7",
      liquidityBps: "11",
    });
    expect(result.frictionScenarios).toEqual([
      {
        name: "optimistic",
        feeBps: "6",
        spreadBps: "9",
        slippageBps: "4",
        liquidityBps: "5",
        combinedMarketImpactBps: "9",
        provenance: "illustrative-derived",
      },
      {
        name: "base",
        feeBps: "12",
        spreadBps: "18",
        slippageBps: "7",
        liquidityBps: "11",
        combinedMarketImpactBps: "18",
        provenance: "illustrative-policy-input",
      },
      {
        name: "stress",
        feeBps: "30",
        spreadBps: "45",
        slippageBps: "18",
        liquidityBps: "27",
        combinedMarketImpactBps: "45",
        provenance: "illustrative-derived",
      },
    ]);
    expect(result.outOfSample.result.runManifest.costModel[1]).toMatchObject({
      name: "base",
      feeBps: "12",
      spreadBps: "18",
      marketImpactBps: "18",
    });
    for (const scenario of result.outOfSample.result.scenarios) {
      expect(scenario.cashBenchmarkReturnBps).toBe("0");
      expect(scenario.buyHoldLiquidationValueEquityMicros).toMatch(/^\d+$/);
    }
    expect(
      result.outOfSample.result.scenarios.map((item) => item.name),
    ).toEqual(["optimistic", "base", "stress"]);
  });

  it("does not mutate the immutable input or the persistent paper ledger", () => {
    const input = fixture();
    const beforeInput = input.map((bar) => ({ ...bar }));
    const engine = new PaperTradingEngine();
    const beforeState = engine.exportState();

    const result = runPaperWalkForwardEvaluation(
      input,
      context,
      evaluationOptions(input),
    );

    expect(input).toEqual(beforeInput);
    expect(engine.exportState()).toEqual(beforeState);
    expect(engine.snapshot().auditLength).toBe(0);
    expectDeeplyFrozen(result);
  });

  it("rejects invalid splits, series, policies, and unpinned data", () => {
    const input = fixture();
    const duplicateObservedAtMs = input[69]?.observedAtMs;
    const lastObservedAtMs = input.at(-1)?.observedAtMs;
    if (duplicateObservedAtMs === undefined) throw new Error("invalid fixture");
    if (lastObservedAtMs === undefined) throw new Error("invalid fixture");
    const base = evaluationOptions(input);

    expect(() =>
      runPaperWalkForwardEvaluation(input, context, {
        ...base,
        protocol: { ...protocol, outOfSampleBars: 21 },
      }),
    ).toThrow("WALK_FORWARD_INVALID_SPLIT");
    expect(() =>
      runPaperWalkForwardEvaluation(input, context, {
        ...base,
        policy: { ...DEFAULT_WALK_FORWARD_POLICY, feeBps: 11n },
      }),
    ).toThrow("WALK_FORWARD_CONFIGURATION_CHECKSUM_MISMATCH");
    expect(() =>
      runPaperWalkForwardEvaluation(input, context, {
        ...base,
        policy: { ...DEFAULT_WALK_FORWARD_POLICY, liquidityBps: -1n },
      }),
    ).toThrow("WALK_FORWARD_INVALID_POLICY");
    expect(() =>
      runPaperWalkForwardEvaluation(input, context, {
        ...base,
        policy: {
          ...DEFAULT_WALK_FORWARD_POLICY,
          fastWindow: 6,
        },
      }),
    ).toThrow("WALK_FORWARD_INVALID_POLICY");
    expect(() =>
      runPaperWalkForwardEvaluation(
        input.map((bar, index) =>
          index === 139 ? { ...bar, priceMicros: bar.priceMicros + 1n } : bar,
        ),
        context,
        base,
      ),
    ).toThrow("WALK_FORWARD_DATASET_CHECKSUM_MISMATCH");
    expect(() =>
      runPaperWalkForwardEvaluation(
        input.map((bar, index) =>
          index === 70 ? { ...bar, observedAtMs: duplicateObservedAtMs } : bar,
        ),
        context,
        { ...base, expectedDatasetSha256: "f".repeat(64) },
      ),
    ).toThrow("WALK_FORWARD_INVALID_PRICE_SERIES");
    expect(() =>
      hashPublicHistoricalDataset(input, {
        ...context,
        retrievedAtMs: lastObservedAtMs - 1,
      }),
    ).toThrow("WALK_FORWARD_INVALID_CONTEXT");
  });
});
