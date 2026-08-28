/**
 * Verifies deterministic paper fills, risk enforcement, state commitments,
 * restart integrity, audit chaining, idempotency, and live-path exclusion.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER_POLICY,
  formatUsdMicros,
  type PaperEngineState,
  PaperTradingEngine,
} from "../src/index.js";
import type { AuditReceipt, PaperOrder } from "../src/types.js";

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

function recommitState(state: PaperEngineState): void {
  const { stateSha256: _stateSha256, ...committedState } = state;
  state.stateSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "paper-engine-state-commitment/v1",
        state: committedState,
      }),
    )
    .digest("hex");
}

function recommitAuditState(state: PaperEngineState): void {
  let previousHash = "0".repeat(64);
  for (const receipt of state.audit) {
    receipt.previousHash = previousHash;
    const { hash: _hash, ...unsigned } = receipt;
    receipt.hash = createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex");
    previousHash = receipt.hash;
  }
  recommitState(state);
}

describe("PaperTradingEngine", () => {
  it("renders micro-fees without hiding them as zero cents", () => {
    expect(formatUsdMicros("501")).toBe("$0.000501");
    expect(formatUsdMicros("19498999")).toBe("$19.498999");
    expect(formatUsdMicros("-6000")).toBe("-$0.006000");
  });

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

  it("accepts a public quote inside the five-minute freshness window", () => {
    const engine = new PaperTradingEngine();
    const receipt = engine.execute(
      order({
        idempotencyKey: "public-cadence",
        quote: {
          symbol: "BTC",
          priceMicros: BTC_PRICE_MICROS,
          observedAtMs: NOW - 240_000,
          source: "coingecko-keyless",
        },
      }),
    );
    expect(receipt).toMatchObject({
      accepted: true,
      reason: "SIMULATED_FILL",
    });
  });

  it("rejects unsafe maximum quote-age policy values", () => {
    const invalidMaxQuoteAges = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const maxQuoteAgeMs of invalidMaxQuoteAges) {
      expect(
        () =>
          new PaperTradingEngine({
            ...DEFAULT_PAPER_POLICY,
            maxQuoteAgeMs,
          }),
      ).toThrow("Invalid fail-closed paper-trading policy");
    }

    expect(
      () =>
        new PaperTradingEngine({
          ...DEFAULT_PAPER_POLICY,
          maxQuoteAgeMs: 1,
        }),
    ).not.toThrow();
  });

  it("rejects unsafe order timestamps without mutating durable paper state", () => {
    const invalidTimestamps = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    const timestampFields = ["requestedAtMs", "observedAtMs"] as const;

    for (const [index, invalidTimestamp] of invalidTimestamps.entries()) {
      for (const field of timestampFields) {
        const engine = new PaperTradingEngine();
        const baseOrder = order({
          idempotencyKey: `invalid-${field}-${index}`,
        });
        const request: PaperOrder =
          field === "requestedAtMs"
            ? { ...baseOrder, requestedAtMs: invalidTimestamp }
            : {
                ...baseOrder,
                quote: {
                  ...baseOrder.quote,
                  observedAtMs: invalidTimestamp,
                },
              };
        const before = engine.snapshot();
        const receipt = engine.execute(request);
        const after = engine.snapshot();

        expect(receipt).toMatchObject({
          accepted: false,
          reason: "INVALID_ORDER_TIMESTAMP",
        });
        expect(Number.isSafeInteger(receipt.recordedAtMs)).toBe(true);
        expect(receipt.recordedAtMs).toBeGreaterThanOrEqual(0);
        expect(after).toEqual({
          ...before,
          auditLength: before.auditLength + 1,
          auditHead: receipt.hash,
        });
        expect(after.auditHead).not.toBe(before.auditHead);
        expect(engine.verifyAuditChain()).toBe(true);

        const state = engine.exportState();
        const serialized = JSON.stringify(state);
        expect(serialized).not.toContain("null");
        expect(
          PaperTradingEngine.fromState(
            JSON.parse(serialized) as PaperEngineState,
          ).exportState(),
        ).toEqual(state);
      }
    }

    const epochEngine = new PaperTradingEngine();
    const epochOrder = order({
      idempotencyKey: "epoch-zero",
      requestedAtMs: 0,
      quote: {
        symbol: "BTC",
        priceMicros: BTC_PRICE_MICROS,
        observedAtMs: 0,
        source: "verified-test-fixture",
      },
    });
    expect(epochEngine.execute(epochOrder)).toMatchObject({
      accepted: true,
      reason: "SIMULATED_FILL",
      recordedAtMs: 0,
    });
    const epochState = epochEngine.exportState();
    expect(
      PaperTradingEngine.fromState(
        JSON.parse(JSON.stringify(epochState)) as PaperEngineState,
      ).exportState(),
    ).toEqual(epochState);
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

  it("restores committed balances, positions, audit receipts, and idempotency", () => {
    const first = new PaperTradingEngine();
    const request = order();
    const receipt = first.execute(request);
    const state = first.exportState();
    const restored = PaperTradingEngine.fromState(state);

    expect(state).toMatchObject({ version: 2 });
    expect(state.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.exportState()).toEqual(state);
    expect(restored.snapshot()).toEqual(first.snapshot());
    expect(restored.execute(request)).toEqual(receipt);
    expect(restored.audit).toHaveLength(1);
    expect(restored.verifyAuditChain()).toBe(true);
  });

  it("fails closed when any committed durable-state field is altered", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    const mutations: Array<(state: PaperEngineState) => void> = [
      (state) => {
        state.cashMicros = "20000000";
      },
      (state) => {
        state.realizedPnlMicros = "1";
      },
      (state) => {
        state.halted = true;
      },
      (state) => {
        state.positions[0]!.symbol = "ETH";
      },
      (state) => {
        state.positions[0]!.quantityAtomic = "1";
      },
      (state) => {
        state.positions[0]!.costBasisMicros = "1";
      },
      (state) => {
        state.positions[0]!.lastMarkPriceMicros = "1";
      },
      (state) => {
        state.audit[0]!.reason = "ALTERED";
      },
      (state) => {
        state.policySha256 = "0".repeat(64);
      },
      (state) => {
        state.stateSha256 = "0".repeat(64);
      },
    ];

    for (const mutate of mutations) {
      const state = engine.exportState();
      mutate(state);
      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_CHECKSUM",
      );
    }
  });

  it("restores representative accepted and rejected receipt shapes", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order({ idempotencyKey: " " }));
    engine.execute(
      order({
        idempotencyKey: "invalid-negative-value",
        quantityAtomic: -1n,
      }),
    );
    engine.execute(
      order({
        idempotencyKey: "invalid-symbol",
        symbol: "DOGE",
      }),
    );
    engine.execute(
      order({
        idempotencyKey: "missing-provenance",
        quote: {
          symbol: "BTC",
          priceMicros: BTC_PRICE_MICROS,
          observedAtMs: NOW,
          source: "",
        },
      }),
    );
    engine.execute(
      order({
        idempotencyKey: "over-limit",
        quantityAtomic: 5_000n,
      }),
    );
    engine.execute(order({ idempotencyKey: "accepted-buy" }));
    engine.execute(
      order({
        idempotencyKey: "accepted-sell",
        side: "sell",
      }),
    );
    const state = engine.exportState();
    const restored = PaperTradingEngine.fromState(
      JSON.parse(JSON.stringify(state)) as PaperEngineState,
    );

    expect(restored.exportState()).toEqual(state);
    expect(restored.audit.map(({ reason }) => reason)).toEqual([
      "MISSING_IDEMPOTENCY_KEY",
      "INVALID_ORDER_VALUE",
      "SYMBOL_NOT_ALLOWED",
      "MISSING_QUOTE_PROVENANCE",
      "MAX_ORDER_EXCEEDED",
      "SIMULATED_FILL",
      "SIMULATED_FILL",
    ]);

    const haltPolicy = {
      ...DEFAULT_PAPER_POLICY,
      maxDailyLossMicros: 1n,
    };
    const halted = new PaperTradingEngine(haltPolicy);
    halted.execute(order({ idempotencyKey: "halt-trigger" }));
    halted.execute(order({ idempotencyKey: "after-halt" }));
    const haltedState = halted.exportState();
    expect(haltedState.halted).toBe(true);
    expect(haltedState.audit.at(-1)?.reason).toBe("DAILY_LOSS_HALT");
    expect(
      PaperTradingEngine.fromState(
        JSON.parse(JSON.stringify(haltedState)) as PaperEngineState,
        haltPolicy,
      ).exportState(),
    ).toEqual(haltedState);
  });

  it("rejects rehashed receipts with invalid fields or fill arithmetic", () => {
    const mutations: Array<(receipt: AuditReceipt) => void> = [
      (receipt) => {
        receipt.mode = "LIVE" as "PAPER";
      },
      (receipt) => {
        receipt.accepted = "true" as unknown as boolean;
      },
      (receipt) => {
        receipt.reason = "UNKNOWN_REASON";
      },
      (receipt) => {
        receipt.idempotencyKey = " ";
      },
      (receipt) => {
        receipt.side = "hold" as "buy";
      },
      (receipt) => {
        receipt.symbol = "btc";
      },
      (receipt) => {
        receipt.quantityAtomic = "0";
      },
      (receipt) => {
        receipt.quotePriceMicros = "-1";
      },
      (receipt) => {
        receipt.executionPriceMicros = "1";
      },
      (receipt) => {
        receipt.notionalMicros = "1";
      },
      (receipt) => {
        receipt.feeMicros = "-1";
      },
      (receipt) => {
        receipt.cashBeforeMicros = "19999999";
      },
      (receipt) => {
        receipt.cashAfterMicros = "19999999";
      },
      (receipt) => {
        receipt.accepted = false;
        receipt.reason = "MAX_ORDER_EXCEEDED";
      },
      (receipt) => {
        delete receipt.feeMicros;
      },
      (receipt) => {
        (receipt as AuditReceipt & { unexpected: string }).unexpected =
          "malleable";
      },
    ];

    for (const mutate of mutations) {
      const engine = new PaperTradingEngine();
      engine.execute(order());
      const state = engine.exportState();
      const receipt = state.audit.at(0);
      if (!receipt) throw new Error("Expected a paper audit receipt");
      mutate(receipt);
      recommitAuditState(state);

      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_AUDIT",
      );
    }
  });

  it("rejects rehashed receipts with inconsistent rejection reasons", () => {
    const mutations: Array<(receipt: AuditReceipt) => void> = [
      (receipt) => {
        receipt.reason = "MAX_ORDER_EXCEEDED";
      },
      (receipt) => {
        receipt.reason = "DAILY_LOSS_HALT";
      },
      (receipt) => {
        receipt.symbol = "DOGE";
      },
      (receipt) => {
        receipt.reason = "INVALID_ORDER_TIMESTAMP";
        receipt.quantityAtomic = "-1";
      },
    ];

    for (const mutate of mutations) {
      const engine = new PaperTradingEngine();
      engine.execute(
        order({
          idempotencyKey: "original-stale-rejection",
          quote: {
            symbol: "BTC",
            priceMicros: BTC_PRICE_MICROS,
            observedAtMs: NOW - DEFAULT_PAPER_POLICY.maxQuoteAgeMs - 1,
            source: "verified-test-fixture",
          },
        }),
      );
      const state = engine.exportState();
      const receipt = state.audit.at(0);
      if (!receipt) throw new Error("Expected a paper audit receipt");
      mutate(receipt);
      recommitAuditState(state);

      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_AUDIT",
      );
    }
  });

  it("rejects rehashed accepted buys that breach execution risk limits", () => {
    const forgeAcceptedBuy = (
      state: PaperEngineState,
      quantityAtomic: bigint,
    ): void => {
      const receipt = state.audit.at(0);
      if (!receipt) throw new Error("Expected a paper audit receipt");
      const executionPrice = 50_100_000_000n;
      const notional =
        (executionPrice * quantityAtomic + 100_000_000n - 1n) / 100_000_000n;
      const fee = (notional * 10n + 10_000n - 1n) / 10_000n;
      const debit = notional + fee;
      receipt.quantityAtomic = quantityAtomic.toString();
      receipt.executionPriceMicros = executionPrice.toString();
      receipt.notionalMicros = notional.toString();
      receipt.feeMicros = fee.toString();
      receipt.cashAfterMicros = (20_000_000n - debit).toString();
      state.cashMicros = receipt.cashAfterMicros;
      state.positions = [
        {
          symbol: "BTC",
          quantityAtomic: quantityAtomic.toString(),
          costBasisMicros: debit.toString(),
          lastMarkPriceMicros: BTC_PRICE_MICROS.toString(),
        },
      ];
      recommitAuditState(state);
    };

    const orderLimitEngine = new PaperTradingEngine();
    orderLimitEngine.execute(order());
    const orderLimitState = orderLimitEngine.exportState();
    forgeAcceptedBuy(orderLimitState, 5_000n);
    expect(() => PaperTradingEngine.fromState(orderLimitState)).toThrow(
      "INVALID_PAPER_STATE_AUDIT",
    );

    const reservePolicy = {
      ...DEFAULT_PAPER_POLICY,
      maxOrderMicros: 15_000_000n,
      maxSymbolExposureMicros: 20_000_000n,
      maxGrossExposureMicros: 20_000_000n,
    };
    const reserveEngine = new PaperTradingEngine(reservePolicy);
    reserveEngine.execute(order());
    const reserveState = reserveEngine.exportState();
    forgeAcceptedBuy(reserveState, 22_000n);
    expect(() =>
      PaperTradingEngine.fromState(reserveState, reservePolicy),
    ).toThrow("INVALID_PAPER_STATE_AUDIT");
  });

  it("rejects a rehashed accepted sell without replayed inventory", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    const state = engine.exportState();
    const receipt = state.audit.at(0);
    if (!receipt) throw new Error("Expected a paper audit receipt");
    receipt.side = "sell";
    receipt.executionPriceMicros = "49900000000";
    receipt.notionalMicros = "998000";
    receipt.feeMicros = "998";
    receipt.cashAfterMicros = "20997002";
    state.cashMicros = receipt.cashAfterMicros;
    state.realizedPnlMicros = "997002";
    state.positions = [];
    recommitAuditState(state);

    expect(() => PaperTradingEngine.fromState(state)).toThrow(
      "INVALID_PAPER_STATE_AUDIT",
    );
  });

  it("rejects rehashed ledgers that disagree with audit replay", () => {
    const mutations: Array<(state: PaperEngineState) => void> = [
      (state) => {
        const position = state.positions.at(0);
        if (!position) throw new Error("Expected a paper position");
        position.costBasisMicros = "1";
      },
      (state) => {
        state.realizedPnlMicros = "1";
      },
      (state) => {
        state.halted = true;
      },
    ];

    for (const mutate of mutations) {
      const engine = new PaperTradingEngine();
      engine.execute(order());
      const state = engine.exportState();
      mutate(state);
      recommitState(state);

      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_AUDIT",
      );
    }
  });

  it("rejects malformed audit hash fields inside a valid state commitment", () => {
    const invalidHashFields = ["previousHash", "hash"] as const;

    for (const field of invalidHashFields) {
      const engine = new PaperTradingEngine();
      engine.execute(order());
      const state = engine.exportState();
      const receipt = state.audit.at(0);
      if (!receipt) throw new Error("Expected a paper audit receipt");
      receipt[field] = "not-a-sha256";
      if (field === "previousHash") {
        const { hash: _hash, ...unsigned } = receipt;
        receipt.hash = createHash("sha256")
          .update(JSON.stringify(unsigned))
          .digest("hex");
      }
      recommitState(state);

      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_AUDIT",
      );
    }
  });

  it("rejects restored audit receipts with unsafe timestamps", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    const invalidTimestamps: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ];

    for (const invalidTimestamp of invalidTimestamps) {
      const state = engine.exportState();
      const receipt = state.audit.at(0);
      if (!receipt) throw new Error("Expected a paper audit receipt");
      receipt.recordedAtMs = invalidTimestamp as number;
      const { hash: _hash, ...unsigned } = receipt;
      receipt.hash = createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex");
      recommitState(state);

      expect(() => PaperTradingEngine.fromState(state)).toThrow(
        "INVALID_PAPER_STATE_AUDIT",
      );
    }
  });

  it("still verifies the audit chain inside a valid state commitment", () => {
    const engine = new PaperTradingEngine();
    engine.execute(order());
    const state = engine.exportState();
    state.audit[0]!.hash = "0".repeat(64);
    recommitState(state);

    expect(() => PaperTradingEngine.fromState(state)).toThrow(
      "INVALID_PAPER_STATE_AUDIT_HASH",
    );
  });

  it("binds restart state to the risk policy and rejects legacy v1 state", () => {
    const engine = new PaperTradingEngine();
    const state = engine.exportState();

    expect(() =>
      PaperTradingEngine.fromState(state, {
        ...DEFAULT_PAPER_POLICY,
        maxOrderMicros: DEFAULT_PAPER_POLICY.maxOrderMicros - 1n,
      }),
    ).toThrow("INVALID_PAPER_STATE_POLICY_MISMATCH");

    const invalidHalt = {
      ...state,
      halted: "true",
    } as unknown as PaperEngineState;
    recommitState(invalidHalt);
    expect(() => PaperTradingEngine.fromState(invalidHalt)).toThrow(
      "INVALID_PAPER_STATE_HALTED",
    );

    const legacy = { ...state, version: 1 } as unknown as PaperEngineState;
    expect(() => PaperTradingEngine.fromState(legacy)).toThrow(
      "INVALID_PAPER_STATE_VERSION",
    );
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

    expect(packageJson.dependencies).toEqual({
      "@elizaos/core": "workspace:*",
    });
    expect(source).not.toMatch(
      /from\s+["'][^"']*(wallet|exchange|ethers|viem|solana|web3)/i,
    );
    expect(source).not.toMatch(
      /process\.env|private.?key|seed.?phrase|api.?key/i,
    );
  });
});
