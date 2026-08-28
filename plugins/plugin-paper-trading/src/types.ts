/**
 * Defines paper-only orders, risk policies, ledger snapshots, audit receipts,
 * and versioned persistence contracts shared across the plugin.
 */
export const USD_SCALE = 1_000_000n;
export const ASSET_SCALE = 100_000_000n;
export const BPS_SCALE = 10_000n;

export type PaperSide = "buy" | "sell";

export interface QuoteSnapshot {
  symbol: string;
  priceMicros: bigint;
  observedAtMs: number;
  source: string;
}

export interface PaperOrder {
  idempotencyKey: string;
  side: PaperSide;
  symbol: string;
  quantityAtomic: bigint;
  quote: QuoteSnapshot;
  requestedAtMs: number;
}

export interface RiskPolicy {
  initialCashMicros: bigint;
  maxOrderMicros: bigint;
  maxSymbolExposureMicros: bigint;
  maxGrossExposureMicros: bigint;
  minCashReserveMicros: bigint;
  maxDailyLossMicros: bigint;
  feeBps: bigint;
  slippageBps: bigint;
  maxQuoteAgeMs: number;
  symbolAllowlist: readonly string[];
}

export interface PaperPosition {
  symbol: string;
  quantityAtomic: bigint;
  costBasisMicros: bigint;
  lastMarkPriceMicros: bigint;
}

export interface PaperLedger {
  cashMicros: bigint;
  realizedPnlMicros: bigint;
  positions: Map<string, PaperPosition>;
  halted: boolean;
}

export interface AuditReceipt {
  sequence: number;
  mode: "PAPER";
  accepted: boolean;
  reason: string;
  idempotencyKey: string;
  side: PaperSide;
  symbol: string;
  quantityAtomic: string;
  quotePriceMicros: string;
  executionPriceMicros?: string;
  notionalMicros?: string;
  feeMicros?: string;
  cashBeforeMicros: string;
  cashAfterMicros: string;
  previousHash: string;
  hash: string;
  recordedAtMs: number;
}

export interface PaperSnapshot {
  mode: "PAPER";
  cashMicros: string;
  realizedPnlMicros: string;
  grossExposureMicros: string;
  equityMicros: string;
  halted: boolean;
  positions: Array<{
    symbol: string;
    quantityAtomic: string;
    costBasisMicros: string;
    lastMarkPriceMicros: string;
  }>;
  auditLength: number;
  auditHead: string;
}

export interface PaperEngineState {
  version: 2;
  policySha256: string;
  cashMicros: string;
  realizedPnlMicros: string;
  halted: boolean;
  positions: Array<{
    symbol: string;
    quantityAtomic: string;
    costBasisMicros: string;
    lastMarkPriceMicros: string;
  }>;
  audit: AuditReceipt[];
  stateSha256: string;
}

export interface PublicMarketQuote {
  symbol: "BTC" | "ETH";
  priceMicros: bigint;
  observedAtMs: number;
  source: "coingecko-keyless";
}
