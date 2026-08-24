import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { runPaperBacktest } from "./backtest.js";
import { ASSET_SCALE, USD_SCALE } from "./types.js";
import { getPaperTradingService } from "./service.js";

const OPERATIONS = ["status", "quote", "backtest", "buy", "sell"] as const;
type Operation = (typeof OPERATIONS)[number];

function params(options?: HandlerOptions): Record<string, unknown> {
  const value = options?.parameters;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function decimalToFixed(value: unknown, scale: bigint, decimals: number): bigint {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : text(value);
  if (!raw || !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`).test(raw)) {
    throw new Error("INVALID_POSITIVE_DECIMAL");
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  const padded = fraction.padEnd(decimals, "0");
  const result =
    BigInt(whole) * scale + BigInt(padded.length > 0 ? padded : "0");
  if (result <= 0n) throw new Error("INVALID_POSITIVE_DECIMAL");
  return result;
}

export function formatUsdMicros(micros: string): string {
  const value = BigInt(micros);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const dollars = absolute / USD_SCALE;
  const fraction = (absolute % USD_SCALE).toString().padStart(6, "0");
  return `${sign}$${dollars}.${fraction}`;
}

function statusText(runtime: IAgentRuntime): string {
  const snapshot = getPaperTradingService(runtime).snapshot();
  const positions =
    snapshot.positions.length === 0
      ? "none"
      : snapshot.positions
          .map(
            (position) =>
              `${position.symbol} quantityAtomic=${position.quantityAtomic}`,
          )
          .join(", ");
  return [
    "PAPER / SIMULATION ONLY",
    `Cash: ${formatUsdMicros(snapshot.cashMicros)}`,
    `Equity: ${formatUsdMicros(snapshot.equityMicros)}`,
    `Gross exposure: ${formatUsdMicros(snapshot.grossExposureMicros)}`,
    `Realized P&L: ${formatUsdMicros(snapshot.realizedPnlMicros)}`,
    `Risk halt: ${snapshot.halted ? "ACTIVE" : "inactive"}`,
    `Positions: ${positions}`,
    `Audit events: ${snapshot.auditLength}`,
  ].join("\n");
}

function failure(message: string, code: string): ActionResult {
  return {
    success: false,
    text: message,
    error: code,
    data: { actionName: "PAPER_TRADING", mode: "PAPER", error: code },
  };
}

export const paperTradingAction: Action = {
  name: "PAPER_TRADING",
  contexts: ["general"],
  similes: [
    "PAPER_TRADE",
    "PAPER_BUY",
    "PAPER_SELL",
    "PAPER_PORTFOLIO",
    "PAPER_STATUS",
    "SIMULATE_TRADE",
    "PAPER_BACKTEST",
    "BACKTEST_CRYPTO",
    "HISTORICAL_PAPER_TEST",
  ],
  description:
    "Owner-only wallet-free paper trading. status reads the simulated portfolio; quote reads a keyless public BTC/ETH quote; backtest evaluates a deterministic moving-average strategy on public historical data; buy and sell create deterministic simulated fills. Never routes live orders, wallets, transfers, or credentials.",
  descriptionCompressed:
    "paper-only portfolio, public quote, historical backtest, simulated buy/sell; no live execution",
  routingHint:
    "Use only when the owner explicitly asks for paper/simulated trading, a BTC/ETH public quote, a historical paper backtest/research result, or the paper portfolio. Never use for a live trade, wallet, swap, transfer, withdrawal, deposit, leverage, short, or credential request. buy/sell require symbol, decimal quantity, and idempotencyKey; omit quote fields to use the read-only public source.",
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const input = params(options);
    const rawOperation = text(input.operation)?.toLowerCase() ?? "status";
    if (!(OPERATIONS as readonly string[]).includes(rawOperation)) {
      return failure(
        "Paper trading supports status, quote, backtest, buy, or sell only.",
        "PAPER_UNKNOWN_OPERATION",
      );
    }
    const operation = rawOperation as Operation;
    if (operation === "status") {
      const output = statusText(runtime);
      await callback?.({
        text: output,
        source: "action",
        action: "PAPER_TRADING",
      });
      return {
        success: true,
        text: output,
        userFacingText: output,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { actionName: "PAPER_TRADING", mode: "PAPER", operation },
      };
    }

    if (operation === "quote") {
      try {
        const symbol = text(input.symbol)?.toUpperCase();
        if (!symbol) return failure("A public quote requires BTC or ETH.", "PAPER_MISSING_SYMBOL");
        const quote = await getPaperTradingService(runtime).publicQuote(symbol);
        const output = [
          "PUBLIC MARKET DATA / READ ONLY",
          `Symbol: ${quote.symbol}`,
          `Price: ${formatUsdMicros(quote.priceMicros.toString())}`,
          `Observed: ${new Date(quote.observedAtMs).toISOString()}`,
          `Source: ${quote.source}`,
        ].join("\n");
        await callback?.({ text: output, source: "action", action: "PAPER_TRADING" });
        return {
          success: true,
          text: output,
          userFacingText: output,
          verifiedUserFacing: true,
          turnComplete: true,
          data: { actionName: "PAPER_TRADING", mode: "READ_ONLY", operation, quote: {
            ...quote,
            priceMicros: quote.priceMicros.toString(),
          } },
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : "PUBLIC_QUOTE_FAILED";
        return failure("The public quote could not be verified.", code);
      }
    }

    if (operation === "backtest") {
      try {
        const symbol = text(input.symbol)?.toUpperCase();
        const rawDays = typeof input.days === "number" ? input.days : Number(text(input.days) ?? "90");
        if (!symbol || !["BTC", "ETH"].includes(symbol) || ![30, 90, 180, 365].includes(rawDays)) {
          return failure(
            "A paper backtest requires BTC or ETH and days of 30, 90, 180, or 365.",
            "PAPER_INVALID_BACKTEST_PARAMETERS",
          );
        }
        const days = rawDays as 30 | 90 | 180 | 365;
        const prices = await getPaperTradingService(runtime).publicHistory(symbol, days);
        const result = runPaperBacktest(prices, undefined, {
          symbol,
          source: "coingecko-keyless",
          windowDays: days,
        });
        const formatPercent = (bps: string): string => {
          const value = BigInt(bps);
          const sign = value < 0n ? "-" : "";
          const absolute = value < 0n ? -value : value;
          return `${sign}${absolute / 100n}.${(absolute % 100n)
            .toString()
            .padStart(2, "0")}%`;
        };
        const output = [
          "PAPER BACKTEST / RESEARCH ONLY",
          `Symbol: ${symbol}`,
          `Historical bars: ${result.bars}`,
          `Simulated trades: ${result.trades}`,
          `Starting equity: ${formatUsdMicros(result.initialEquityMicros)}`,
          `Ending equity: ${formatUsdMicros(result.endingEquityMicros)}`,
          `Modeled return: ${formatPercent(result.returnBps)}`,
          `Maximum drawdown: ${formatPercent(result.maxDrawdownBps)}`,
          `Final research signal: ${result.finalSignal}`,
          `Dataset as of: ${new Date(result.asOfMs).toISOString()}`,
          `Evidence SHA-256: ${result.evidenceHash}`,
          `Algorithm: ${result.algorithmVersion}`,
          "This is a historical simulation, not a profit forecast or live-trade instruction.",
        ].join("\n");
        await callback?.({ text: output, source: "action", action: "PAPER_TRADING" });
        return {
          success: true,
          text: output,
          userFacingText: output,
          verifiedUserFacing: true,
          turnComplete: true,
          data: {
            actionName: "PAPER_TRADING",
            mode: "PAPER_BACKTEST",
            operation,
            symbol,
            days,
            result,
          },
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : "PAPER_BACKTEST_FAILED";
        return failure("The paper backtest could not be completed safely.", code);
      }
    }

    try {
      const symbol = text(input.symbol)?.toUpperCase();
      const idempotencyKey = text(input.idempotencyKey);
      if (!symbol || !idempotencyKey) {
        return failure(
          "A simulated order requires symbol, quantity, and idempotencyKey.",
          "PAPER_MISSING_ORDER_FIELDS",
        );
      }
      const quantityAtomic = decimalToFixed(input.quantity, ASSET_SCALE, 8);
      const suppliedPrice = text(input.priceUsd);
      const service = getPaperTradingService(runtime);
      const publicQuote = suppliedPrice ? undefined : await service.publicQuote(symbol);
      const quoteSource = publicQuote?.source ?? text(input.quoteSource);
      const observedAt = publicQuote?.observedAtMs ??
        Date.parse(text(input.quoteObservedAt) ?? "");
      if (!quoteSource || !Number.isFinite(observedAt)) {
        return failure(
          "A supplied simulation quote requires quoteSource and quoteObservedAt.",
          "PAPER_MISSING_QUOTE_FIELDS",
        );
      }
      const priceMicros = publicQuote?.priceMicros ??
        decimalToFixed(suppliedPrice, USD_SCALE, 6);
      const auditLengthBefore = service.snapshot().auditLength;
      const receipt = service.execute({
        idempotencyKey,
        side: operation,
        symbol,
        quantityAtomic,
        quote: {
          symbol,
          priceMicros,
          observedAtMs: observedAt,
          source: quoteSource,
        },
        requestedAtMs: Date.now(),
      });
      const replayed = service.snapshot().auditLength === auditLengthBefore;
      const outcome = replayed
        ? "Existing simulated receipt returned; no new fill occurred."
        : receipt.accepted
          ? "Simulated fill accepted."
          : "Simulated order rejected.";
      const output = [
        "PAPER / SIMULATION ONLY",
        outcome,
        `Reason: ${receipt.reason}`,
        `Symbol: ${receipt.symbol}`,
        `Quantity atomic: ${receipt.quantityAtomic}`,
        ...(receipt.notionalMicros
          ? [`Notional: ${formatUsdMicros(receipt.notionalMicros)}`]
          : []),
        ...(receipt.feeMicros ? [`Modeled fee: ${formatUsdMicros(receipt.feeMicros)}`] : []),
        `Audit receipt: ${receipt.hash}`,
      ].join("\n");
      await callback?.({
        text: output,
        source: "action",
        action: "PAPER_TRADING",
      });
      return {
        success: receipt.accepted,
        text: output,
        ...(receipt.accepted ? {} : { error: receipt.reason }),
        userFacingText: output,
        verifiedUserFacing: true,
        turnComplete: true,
        data: {
          actionName: "PAPER_TRADING",
          mode: "PAPER",
          operation,
          replayed,
          receipt,
        },
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : "PAPER_INVALID_ORDER";
      return failure("The simulated order parameters were invalid.", code);
    }
  },
  parameters: [
    {
      name: "operation",
      description: "Paper operation: status, quote, backtest, buy, or sell.",
      required: true,
      schema: { type: "string", enum: [...OPERATIONS] },
    },
    {
      name: "days",
      description: "Historical backtest window: 30, 90, 180, or 365 days.",
      required: false,
      schema: { type: "number", enum: [30, 90, 180, 365] },
    },
    {
      name: "symbol",
      description: "Allowlisted simulated asset symbol: BTC or ETH.",
      required: false,
      schema: { type: "string", enum: ["BTC", "ETH"] },
    },
    {
      name: "quantity",
      description:
        "Positive decimal asset quantity with at most 8 decimal places.",
      required: false,
      schema: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,8})?$" },
    },
    {
      name: "priceUsd",
      description:
        "Positive decimal USD quote with at most 6 decimal places, supplied only for simulation.",
      required: false,
      schema: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$" },
    },
    {
      name: "quoteSource",
      description: "Public source/provenance label for the supplied quote.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "quoteObservedAt",
      description: "ISO-8601 observation time for freshness validation.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "idempotencyKey",
      description: "Unique key preventing a simulated order from filling twice.",
      required: false,
      schema: { type: "string", minLength: 1 },
    },
  ],
  examples: [],
};
