import { createHash } from "node:crypto";
import {
  ASSET_SCALE,
  BPS_SCALE,
  type AuditReceipt,
  type PaperEngineState,
  type PaperLedger,
  type PaperOrder,
  type PaperPosition,
  type PaperSnapshot,
  type RiskPolicy,
} from "./types.js";

const ZERO_HASH = "0".repeat(64);

function ceilDiv(value: bigint, divisor: bigint): bigint {
  if (value < 0n || divisor <= 0n) {
    throw new Error("ceilDiv accepts only non-negative values and a positive divisor");
  }
  return (value + divisor - 1n) / divisor;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  if (value < 0n || divisor <= 0n) {
    throw new Error("floorDiv accepts only non-negative values and a positive divisor");
  }
  return value / divisor;
}

function hashReceipt(receipt: Omit<AuditReceipt, "hash">): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

export const DEFAULT_PAPER_POLICY: RiskPolicy = Object.freeze({
  initialCashMicros: 20_000_000n,
  maxOrderMicros: 2_000_000n,
  maxSymbolExposureMicros: 5_000_000n,
  maxGrossExposureMicros: 10_000_000n,
  minCashReserveMicros: 10_000_000n,
  maxDailyLossMicros: 1_000_000n,
  feeBps: 10n,
  slippageBps: 20n,
  maxQuoteAgeMs: 300_000,
  symbolAllowlist: ["BTC", "ETH"],
});

export class PaperTradingEngine {
  readonly policy: RiskPolicy;
  readonly ledger: PaperLedger;
  readonly audit: AuditReceipt[] = [];

  readonly #receiptsByKey = new Map<string, AuditReceipt>();

  constructor(policy: RiskPolicy = DEFAULT_PAPER_POLICY) {
    this.policy = {
      ...policy,
      symbolAllowlist: policy.symbolAllowlist.map((symbol) =>
        symbol.trim().toUpperCase(),
      ),
    };
    this.#validatePolicy();
    this.ledger = {
      cashMicros: this.policy.initialCashMicros,
      realizedPnlMicros: 0n,
      positions: new Map(),
      halted: false,
    };
  }

  execute(order: PaperOrder): AuditReceipt {
    const duplicate = this.#receiptsByKey.get(order.idempotencyKey);
    if (duplicate) return duplicate;

    const cashBefore = this.ledger.cashMicros;
    const symbol = order.symbol.trim().toUpperCase();
    const failure = this.#validateOrder(order, symbol);
    if (failure) {
      return this.#record(order, symbol, cashBefore, false, failure);
    }

    const executionPrice =
      order.side === "buy"
        ? ceilDiv(
            order.quote.priceMicros *
              (BPS_SCALE + this.policy.slippageBps),
            BPS_SCALE,
          )
        : floorDiv(
            order.quote.priceMicros *
              (BPS_SCALE - this.policy.slippageBps),
            BPS_SCALE,
          );
    const notional =
      order.side === "buy"
        ? ceilDiv(executionPrice * order.quantityAtomic, ASSET_SCALE)
        : floorDiv(executionPrice * order.quantityAtomic, ASSET_SCALE);
    const fee = ceilDiv(notional * this.policy.feeBps, BPS_SCALE);

    if (notional <= 0n || fee >= notional) {
      return this.#record(
        order,
        symbol,
        cashBefore,
        false,
        "ORDER_TOO_SMALL_AFTER_ROUNDING",
      );
    }

    if (order.side === "buy") {
      const debit = notional + fee;
      const current = this.ledger.positions.get(symbol);
      const currentQuantity = current?.quantityAtomic ?? 0n;
      const newQuantity = currentQuantity + order.quantityAtomic;
      const newSymbolExposure = ceilDiv(
        executionPrice * newQuantity,
        ASSET_SCALE,
      );
      const grossBefore = this.#grossExposure();
      const oldExposure = current
        ? floorDiv(
            current.lastMarkPriceMicros * current.quantityAtomic,
            ASSET_SCALE,
          )
        : 0n;
      const grossAfter = grossBefore - oldExposure + newSymbolExposure;

      if (debit > this.policy.maxOrderMicros) {
        return this.#record(order, symbol, cashBefore, false, "MAX_ORDER_EXCEEDED");
      }
      if (cashBefore < debit) {
        return this.#record(order, symbol, cashBefore, false, "INSUFFICIENT_CASH");
      }
      if (cashBefore - debit < this.policy.minCashReserveMicros) {
        return this.#record(order, symbol, cashBefore, false, "MIN_RESERVE_BREACH");
      }
      if (newSymbolExposure > this.policy.maxSymbolExposureMicros) {
        return this.#record(
          order,
          symbol,
          cashBefore,
          false,
          "MAX_SYMBOL_EXPOSURE_EXCEEDED",
        );
      }
      if (grossAfter > this.policy.maxGrossExposureMicros) {
        return this.#record(
          order,
          symbol,
          cashBefore,
          false,
          "MAX_GROSS_EXPOSURE_EXCEEDED",
        );
      }

      const next: PaperPosition = {
        symbol,
        quantityAtomic: newQuantity,
        costBasisMicros: (current?.costBasisMicros ?? 0n) + debit,
        lastMarkPriceMicros: order.quote.priceMicros,
      };
      this.ledger.cashMicros -= debit;
      this.ledger.positions.set(symbol, next);
    } else {
      const current = this.ledger.positions.get(symbol);
      if (!current || current.quantityAtomic < order.quantityAtomic) {
        return this.#record(
          order,
          symbol,
          cashBefore,
          false,
          "INSUFFICIENT_PAPER_POSITION",
        );
      }

      const credit = notional - fee;
      const removedCost = floorDiv(
        current.costBasisMicros * order.quantityAtomic,
        current.quantityAtomic,
      );
      const remainingQuantity = current.quantityAtomic - order.quantityAtomic;
      this.ledger.cashMicros += credit;
      this.ledger.realizedPnlMicros += credit - removedCost;

      if (remainingQuantity === 0n) {
        this.ledger.positions.delete(symbol);
      } else {
        this.ledger.positions.set(symbol, {
          ...current,
          quantityAtomic: remainingQuantity,
          costBasisMicros: current.costBasisMicros - removedCost,
          lastMarkPriceMicros: order.quote.priceMicros,
        });
      }
    }

    const receipt = this.#record(
      order,
      symbol,
      cashBefore,
      true,
      "SIMULATED_FILL",
      executionPrice,
      notional,
      fee,
    );
    this.#applyLossHalt();
    return receipt;
  }

  snapshot(): PaperSnapshot {
    const gross = this.#grossExposure();
    return {
      mode: "PAPER",
      cashMicros: this.ledger.cashMicros.toString(),
      realizedPnlMicros: this.ledger.realizedPnlMicros.toString(),
      grossExposureMicros: gross.toString(),
      equityMicros: (this.ledger.cashMicros + gross).toString(),
      halted: this.ledger.halted,
      positions: [...this.ledger.positions.values()].map((position) => ({
        symbol: position.symbol,
        quantityAtomic: position.quantityAtomic.toString(),
        costBasisMicros: position.costBasisMicros.toString(),
        lastMarkPriceMicros: position.lastMarkPriceMicros.toString(),
      })),
      auditLength: this.audit.length,
      auditHead: this.audit.at(-1)?.hash ?? ZERO_HASH,
    };
  }

  verifyAuditChain(): boolean {
    let previousHash = ZERO_HASH;
    for (const receipt of this.audit) {
      if (receipt.previousHash !== previousHash) return false;
      const { hash, ...unsigned } = receipt;
      if (hashReceipt(unsigned) !== hash) return false;
      previousHash = hash;
    }
    return true;
  }

  exportState(): PaperEngineState {
    return {
      version: 1,
      cashMicros: this.ledger.cashMicros.toString(),
      realizedPnlMicros: this.ledger.realizedPnlMicros.toString(),
      halted: this.ledger.halted,
      positions: [...this.ledger.positions.values()].map((position) => ({
        symbol: position.symbol,
        quantityAtomic: position.quantityAtomic.toString(),
        costBasisMicros: position.costBasisMicros.toString(),
        lastMarkPriceMicros: position.lastMarkPriceMicros.toString(),
      })),
      audit: this.audit.map((receipt) => ({ ...receipt })),
    };
  }

  static fromState(
    state: PaperEngineState,
    policy: RiskPolicy = DEFAULT_PAPER_POLICY,
  ): PaperTradingEngine {
    if (!state || state.version !== 1 || !Array.isArray(state.positions) || !Array.isArray(state.audit)) {
      throw new Error("INVALID_PAPER_STATE_VERSION");
    }
    const parseUnsigned = (value: string, field: string): bigint => {
      if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
        throw new Error(`INVALID_PAPER_STATE_${field}`);
      }
      return BigInt(value);
    };
    const parseSigned = (value: string, field: string): bigint => {
      if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
        throw new Error(`INVALID_PAPER_STATE_${field}`);
      }
      return BigInt(value);
    };

    const engine = new PaperTradingEngine(policy);
    engine.ledger.cashMicros = parseUnsigned(state.cashMicros, "CASH");
    engine.ledger.realizedPnlMicros = parseSigned(
      state.realizedPnlMicros,
      "REALIZED_PNL",
    );
    engine.ledger.halted = state.halted === true;
    engine.ledger.positions.clear();

    for (const stored of state.positions) {
      const symbol = stored.symbol?.trim().toUpperCase();
      if (
        !symbol ||
        !engine.policy.symbolAllowlist.includes(symbol) ||
        engine.ledger.positions.has(symbol)
      ) {
        throw new Error("INVALID_PAPER_STATE_POSITION");
      }
      const position: PaperPosition = {
        symbol,
        quantityAtomic: parseUnsigned(stored.quantityAtomic, "QUANTITY"),
        costBasisMicros: parseUnsigned(stored.costBasisMicros, "COST_BASIS"),
        lastMarkPriceMicros: parseUnsigned(stored.lastMarkPriceMicros, "MARK"),
      };
      if (
        position.quantityAtomic <= 0n ||
        position.costBasisMicros <= 0n ||
        position.lastMarkPriceMicros <= 0n
      ) {
        throw new Error("INVALID_PAPER_STATE_POSITION");
      }
      engine.ledger.positions.set(symbol, position);
    }

    engine.audit.splice(0, engine.audit.length, ...state.audit.map((receipt) => ({ ...receipt })));
    for (const [index, receipt] of engine.audit.entries()) {
      if (
        receipt.sequence !== index + 1 ||
        !receipt.idempotencyKey?.trim() ||
        engine.#receiptsByKey.has(receipt.idempotencyKey)
      ) {
        throw new Error("INVALID_PAPER_STATE_AUDIT");
      }
      engine.#receiptsByKey.set(receipt.idempotencyKey, receipt);
    }
    if (!engine.verifyAuditChain()) {
      throw new Error("INVALID_PAPER_STATE_AUDIT_HASH");
    }
    const finalCash = engine.audit.at(-1)?.cashAfterMicros;
    if (finalCash !== undefined && finalCash !== engine.ledger.cashMicros.toString()) {
      throw new Error("INVALID_PAPER_STATE_CASH_MISMATCH");
    }
    return engine;
  }

  #validatePolicy(): void {
    const p = this.policy;
    const monetary = [
      p.initialCashMicros,
      p.maxOrderMicros,
      p.maxSymbolExposureMicros,
      p.maxGrossExposureMicros,
      p.minCashReserveMicros,
      p.maxDailyLossMicros,
    ];
    if (monetary.some((value) => value < 0n)) {
      throw new Error("Paper-trading monetary limits must be non-negative");
    }
    if (
      p.initialCashMicros <= 0n ||
      p.minCashReserveMicros > p.initialCashMicros ||
      p.feeBps < 0n ||
      p.slippageBps < 0n ||
      p.slippageBps >= BPS_SCALE ||
      p.maxQuoteAgeMs <= 0 ||
      p.symbolAllowlist.length === 0
    ) {
      throw new Error("Invalid fail-closed paper-trading policy");
    }
  }

  #validateOrder(order: PaperOrder, symbol: string): string | undefined {
    if (!order.idempotencyKey.trim()) return "MISSING_IDEMPOTENCY_KEY";
    if (this.ledger.halted) return "DAILY_LOSS_HALT";
    if (!this.policy.symbolAllowlist.includes(symbol)) return "SYMBOL_NOT_ALLOWED";
    if (order.quote.symbol.trim().toUpperCase() !== symbol) {
      return "QUOTE_SYMBOL_MISMATCH";
    }
    if (!order.quote.source.trim()) return "MISSING_QUOTE_PROVENANCE";
    if (order.quote.priceMicros <= 0n || order.quantityAtomic <= 0n) {
      return "INVALID_ORDER_VALUE";
    }
    const quoteAge = order.requestedAtMs - order.quote.observedAtMs;
    if (quoteAge < 0 || quoteAge > this.policy.maxQuoteAgeMs) {
      return "STALE_OR_FUTURE_QUOTE";
    }
    return undefined;
  }

  #grossExposure(): bigint {
    let gross = 0n;
    for (const position of this.ledger.positions.values()) {
      gross += floorDiv(
        position.lastMarkPriceMicros * position.quantityAtomic,
        ASSET_SCALE,
      );
    }
    return gross;
  }

  #applyLossHalt(): void {
    const equity = this.ledger.cashMicros + this.#grossExposure();
    if (
      equity <=
      this.policy.initialCashMicros - this.policy.maxDailyLossMicros
    ) {
      this.ledger.halted = true;
    }
  }

  #record(
    order: PaperOrder,
    symbol: string,
    cashBefore: bigint,
    accepted: boolean,
    reason: string,
    executionPrice?: bigint,
    notional?: bigint,
    fee?: bigint,
  ): AuditReceipt {
    const previousHash = this.audit.at(-1)?.hash ?? ZERO_HASH;
    const unsigned: Omit<AuditReceipt, "hash"> = {
      sequence: this.audit.length + 1,
      mode: "PAPER",
      accepted,
      reason,
      idempotencyKey: order.idempotencyKey,
      side: order.side,
      symbol,
      quantityAtomic: order.quantityAtomic.toString(),
      quotePriceMicros: order.quote.priceMicros.toString(),
      ...(executionPrice === undefined
        ? {}
        : { executionPriceMicros: executionPrice.toString() }),
      ...(notional === undefined ? {} : { notionalMicros: notional.toString() }),
      ...(fee === undefined ? {} : { feeMicros: fee.toString() }),
      cashBeforeMicros: cashBefore.toString(),
      cashAfterMicros: this.ledger.cashMicros.toString(),
      previousHash,
      recordedAtMs: order.requestedAtMs,
    };
    const receipt: AuditReceipt = {
      ...unsigned,
      hash: hashReceipt(unsigned),
    };
    this.audit.push(receipt);
    this.#receiptsByKey.set(order.idempotencyKey, receipt);
    return receipt;
  }
}
