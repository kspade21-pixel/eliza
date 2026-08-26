/**
 * Builds immutable, policy-bound paper-trading previews and validates approval
 * intents without exposing any live execution path.
 */
import { createHash } from "node:crypto";
import { DEFAULT_PAPER_POLICY, PaperTradingEngine } from "./engine.js";
import type {
  AuditReceipt,
  PaperEngineState,
  PaperOrder,
  PaperSnapshot,
  RiskPolicy,
} from "./types.js";

export interface PaperDryRunPlan {
  schemaVersion: 1;
  mode: "PAPER_DRY_RUN";
  planHash: string;
  order: {
    idempotencyKey: string;
    side: PaperOrder["side"];
    symbol: string;
    quantityAtomic: string;
    quotePriceMicros: string;
    quoteObservedAtMs: number;
    quoteSource: string;
    requestedAtMs: number;
  };
  effectivePolicy: {
    initialCashMicros: string;
    maxOrderMicros: string;
    maxSymbolExposureMicros: string;
    maxGrossExposureMicros: string;
    minCashReserveMicros: string;
    maxDailyLossMicros: string;
    feeBps: string;
    slippageBps: string;
    maxQuoteAgeMs: number;
    symbolAllowlist: readonly string[];
  };
  snapshotBefore: PaperSnapshot;
  projectedReceipt: AuditReceipt;
  executed: false;
}

export interface PaperApprovalIntent {
  schemaVersion: 1;
  mode: "PAPER_DRY_RUN";
  decision: "APPROVE_SIMULATION" | "REJECT";
  planHash: string;
  intentId: string;
  approvedAtMs: number;
  expiresAtMs: number;
}

export interface NoOpExecutionReceipt {
  mode: "PAPER_DRY_RUN";
  planHash: string;
  approvalStatus: "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "APPROVAL_INVALID" | "APPROVAL_BOUND";
  executed: false;
  reason: "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "INVALID_APPROVAL_INTENT" | "LIVE_EXECUTION_UNAVAILABLE_BY_DESIGN";
}

const SHA256 = /^[a-f0-9]{64}$/;
const INTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const INTEGER = /^(?:0|[1-9]\d*)$/;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePolicy(policy: RiskPolicy): PaperDryRunPlan["effectivePolicy"] {
  if (!isRecord(policy)) throw new Error("INVALID_PAPER_DRY_RUN_POLICY");
  const bigintFields = [
    "initialCashMicros",
    "maxOrderMicros",
    "maxSymbolExposureMicros",
    "maxGrossExposureMicros",
    "minCashReserveMicros",
    "maxDailyLossMicros",
    "feeBps",
    "slippageBps",
  ] as const;
  if (
    bigintFields.some((field) => typeof policy[field] !== "bigint") ||
    !Number.isSafeInteger(policy.maxQuoteAgeMs) ||
    !Array.isArray(policy.symbolAllowlist) ||
    policy.symbolAllowlist.some((symbol) => typeof symbol !== "string")
  ) {
    throw new Error("INVALID_PAPER_DRY_RUN_POLICY");
  }
  return {
    initialCashMicros: policy.initialCashMicros.toString(),
    maxOrderMicros: policy.maxOrderMicros.toString(),
    maxSymbolExposureMicros: policy.maxSymbolExposureMicros.toString(),
    maxGrossExposureMicros: policy.maxGrossExposureMicros.toString(),
    minCashReserveMicros: policy.minCashReserveMicros.toString(),
    maxDailyLossMicros: policy.maxDailyLossMicros.toString(),
    feeBps: policy.feeBps.toString(),
    slippageBps: policy.slippageBps.toString(),
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    symbolAllowlist: policy.symbolAllowlist.map((symbol) =>
      symbol.trim().toUpperCase(),
    ),
  };
}

function assertOrder(order: PaperOrder): void {
  if (
    !isRecord(order) ||
    typeof order.idempotencyKey !== "string" ||
    !order.idempotencyKey.trim() ||
    (order.side !== "buy" && order.side !== "sell") ||
    typeof order.symbol !== "string" ||
    !order.symbol.trim() ||
    typeof order.quantityAtomic !== "bigint" ||
    !isRecord(order.quote) ||
    typeof order.quote.symbol !== "string" ||
    typeof order.quote.priceMicros !== "bigint" ||
    !Number.isSafeInteger(order.quote.observedAtMs) ||
    typeof order.quote.source !== "string" ||
    !Number.isSafeInteger(order.requestedAtMs)
  ) {
    throw new Error("INVALID_PAPER_DRY_RUN_ORDER");
  }
}

function hashReceipt(receipt: Omit<AuditReceipt, "hash">): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

function duplicateReceipt(
  order: PaperOrder,
  snapshot: PaperSnapshot,
): AuditReceipt {
  const unsigned: Omit<AuditReceipt, "hash"> = {
    sequence: snapshot.auditLength + 1,
    mode: "PAPER",
    accepted: false,
    reason: "IDEMPOTENCY_KEY_ALREADY_USED",
    idempotencyKey: order.idempotencyKey,
    side: order.side,
    symbol: order.symbol.trim().toUpperCase(),
    quantityAtomic: order.quantityAtomic.toString(),
    quotePriceMicros: order.quote.priceMicros.toString(),
    cashBeforeMicros: snapshot.cashMicros,
    cashAfterMicros: snapshot.cashMicros,
    previousHash: snapshot.auditHead,
    recordedAtMs: order.requestedAtMs,
  };
  return { ...unsigned, hash: hashReceipt(unsigned) };
}

function canonicalPlanInput(
  order: PaperOrder,
  effectivePolicy: PaperDryRunPlan["effectivePolicy"],
  snapshotBefore: PaperSnapshot,
  projectedReceipt: AuditReceipt,
): unknown {
  return {
    schemaVersion: 1,
    mode: "PAPER_DRY_RUN",
    order: {
      idempotencyKey: order.idempotencyKey,
      side: order.side,
      symbol: order.symbol.trim().toUpperCase(),
      quantityAtomic: order.quantityAtomic.toString(),
      quotePriceMicros: order.quote.priceMicros.toString(),
      quoteObservedAtMs: order.quote.observedAtMs,
      quoteSource: order.quote.source,
      requestedAtMs: order.requestedAtMs,
    },
    effectivePolicy,
    snapshotBefore,
    projectedReceipt,
    executed: false,
  };
}

export function buildPaperDryRunPlan(
  state: PaperEngineState,
  order: PaperOrder,
  policy?: RiskPolicy,
): PaperDryRunPlan {
  assertOrder(order);
  const previewEngine = PaperTradingEngine.fromState(
    state,
    policy ?? DEFAULT_PAPER_POLICY,
  );
  const effectivePolicy = normalizePolicy(previewEngine.policy);
  const snapshotBefore = previewEngine.snapshot();
  const projectedReceipt = state.audit.some(
    (receipt) => receipt.idempotencyKey === order.idempotencyKey,
  )
    ? duplicateReceipt(order, snapshotBefore)
    : previewEngine.execute(order);
  const normalized = canonicalPlanInput(
    order,
    effectivePolicy,
    snapshotBefore,
    projectedReceipt,
  );
  const planHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  return deepFreeze({
    ...(normalized as Omit<PaperDryRunPlan, "planHash">),
    planHash,
  });
}

function isValidReceipt(receipt: unknown): receipt is AuditReceipt {
  if (!isRecord(receipt) || !SHA256.test(String(receipt.hash))) return false;
  const { hash, ...unsigned } = receipt;
  return (
    hashReceipt(unsigned as Omit<AuditReceipt, "hash">) === hash &&
    receipt.mode === "PAPER" &&
    Number.isSafeInteger(receipt.sequence) &&
    typeof receipt.accepted === "boolean" &&
    typeof receipt.reason === "string" &&
    typeof receipt.idempotencyKey === "string" &&
    (receipt.side === "buy" || receipt.side === "sell") &&
    typeof receipt.symbol === "string" &&
    typeof receipt.quantityAtomic === "string" &&
    INTEGER.test(receipt.quantityAtomic) &&
    typeof receipt.quotePriceMicros === "string" &&
    INTEGER.test(receipt.quotePriceMicros) &&
    typeof receipt.cashBeforeMicros === "string" &&
    INTEGER.test(receipt.cashBeforeMicros) &&
    typeof receipt.cashAfterMicros === "string" &&
    INTEGER.test(receipt.cashAfterMicros) &&
    typeof receipt.previousHash === "string" &&
    SHA256.test(receipt.previousHash) &&
    Number.isSafeInteger(receipt.recordedAtMs)
  );
}

function isValidSnapshot(snapshot: Record<string, unknown>): boolean {
  if (
    snapshot.mode !== "PAPER" ||
    typeof snapshot.cashMicros !== "string" ||
    !INTEGER.test(snapshot.cashMicros) ||
    typeof snapshot.realizedPnlMicros !== "string" ||
    !/^-?(?:0|[1-9]\d*)$/.test(snapshot.realizedPnlMicros) ||
    typeof snapshot.grossExposureMicros !== "string" ||
    !INTEGER.test(snapshot.grossExposureMicros) ||
    typeof snapshot.equityMicros !== "string" ||
    !INTEGER.test(snapshot.equityMicros) ||
    typeof snapshot.halted !== "boolean" ||
    !Array.isArray(snapshot.positions) ||
    !Number.isSafeInteger(snapshot.auditLength) ||
    (snapshot.auditLength as number) < 0 ||
    typeof snapshot.auditHead !== "string" ||
    !SHA256.test(snapshot.auditHead)
  ) {
    return false;
  }
  return snapshot.positions.every(
    (position) =>
      isRecord(position) &&
      typeof position.symbol === "string" &&
      !!position.symbol.trim() &&
      typeof position.quantityAtomic === "string" &&
      INTEGER.test(position.quantityAtomic) &&
      typeof position.costBasisMicros === "string" &&
      INTEGER.test(position.costBasisMicros) &&
      typeof position.lastMarkPriceMicros === "string" &&
      INTEGER.test(position.lastMarkPriceMicros),
  );
}

function recomputePlanHash(plan: PaperDryRunPlan): string | undefined {
  if (
    !isRecord(plan) ||
    plan.schemaVersion !== 1 ||
    plan.mode !== "PAPER_DRY_RUN" ||
    plan.executed !== false ||
    !isRecord(plan.order) ||
    !isRecord(plan.effectivePolicy) ||
    !isRecord(plan.snapshotBefore) ||
    !isValidSnapshot(plan.snapshotBefore) ||
    !isValidReceipt(plan.projectedReceipt)
  ) {
    return undefined;
  }
  const order = plan.order;
  const policy = plan.effectivePolicy;
  if (
    typeof order.idempotencyKey !== "string" ||
    !order.idempotencyKey.trim() ||
    (order.side !== "buy" && order.side !== "sell") ||
    typeof order.symbol !== "string" ||
    !order.symbol.trim() ||
    typeof order.quantityAtomic !== "string" ||
    !INTEGER.test(order.quantityAtomic) ||
    typeof order.quotePriceMicros !== "string" ||
    !INTEGER.test(order.quotePriceMicros) ||
    !Number.isSafeInteger(order.quoteObservedAtMs) ||
    typeof order.quoteSource !== "string" ||
    !order.quoteSource.trim() ||
    !Number.isSafeInteger(order.requestedAtMs) ||
    !Array.isArray(policy.symbolAllowlist) ||
    policy.symbolAllowlist.some((symbol) => typeof symbol !== "string") ||
    !Number.isSafeInteger(policy.maxQuoteAgeMs)
  ) {
    return undefined;
  }
  const numericPolicyFields = [
    "initialCashMicros",
    "maxOrderMicros",
    "maxSymbolExposureMicros",
    "maxGrossExposureMicros",
    "minCashReserveMicros",
    "maxDailyLossMicros",
    "feeBps",
    "slippageBps",
  ] as const;
  if (numericPolicyFields.some((field) => !INTEGER.test(String(policy[field])))) {
    return undefined;
  }
  if (
    policy.symbolAllowlist.length === 0 ||
    policy.symbolAllowlist.some(
      (symbol) => !symbol.trim() || symbol !== symbol.trim().toUpperCase(),
    ) ||
    BigInt(policy.initialCashMicros as string) <= 0n ||
    BigInt(policy.minCashReserveMicros as string) >
      BigInt(policy.initialCashMicros as string) ||
    BigInt(policy.slippageBps as string) >= 10_000n ||
    (policy.maxQuoteAgeMs as number) <= 0 ||
    plan.projectedReceipt.idempotencyKey !== order.idempotencyKey ||
    plan.projectedReceipt.side !== order.side ||
    plan.projectedReceipt.symbol !== order.symbol ||
    plan.projectedReceipt.quantityAtomic !== order.quantityAtomic ||
    plan.projectedReceipt.quotePriceMicros !== order.quotePriceMicros ||
    plan.projectedReceipt.sequence !== plan.snapshotBefore.auditLength + 1 ||
    plan.projectedReceipt.previousHash !== plan.snapshotBefore.auditHead ||
    plan.projectedReceipt.cashBeforeMicros !== plan.snapshotBefore.cashMicros ||
    plan.projectedReceipt.recordedAtMs !== order.requestedAtMs
  ) {
    return undefined;
  }
  // A persisted idempotency key may be previewed for an explicit audit-safe
  // denial, but it can never become approval-bound again.
  if (
    plan.projectedReceipt.accepted === false &&
    plan.projectedReceipt.reason === "IDEMPOTENCY_KEY_ALREADY_USED"
  ) {
    return undefined;
  }
  const canonical = {
    schemaVersion: 1,
    mode: "PAPER_DRY_RUN",
    order,
    effectivePolicy: policy,
    snapshotBefore: plan.snapshotBefore,
    projectedReceipt: plan.projectedReceipt,
    executed: false,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validatePaperApprovalIntent(
  plan: PaperDryRunPlan,
  intent: PaperApprovalIntent,
  nowMs: number,
): boolean {
  try {
    const recomputedHash = recomputePlanHash(plan);
    if (
      !recomputedHash ||
      !SHA256.test(plan.planHash) ||
      recomputedHash !== plan.planHash ||
      !intent ||
      intent.schemaVersion !== 1 ||
      intent.mode !== "PAPER_DRY_RUN" ||
      intent.decision !== "APPROVE_SIMULATION" ||
      !SHA256.test(intent.planHash) ||
      intent.planHash !== plan.planHash ||
      !INTENT_ID.test(intent.intentId) ||
      !Number.isSafeInteger(intent.approvedAtMs) ||
      !Number.isSafeInteger(intent.expiresAtMs) ||
      !Number.isSafeInteger(nowMs) ||
      intent.approvedAtMs > nowMs ||
      intent.expiresAtMs <= nowMs ||
      intent.expiresAtMs <= intent.approvedAtMs ||
      intent.expiresAtMs - intent.approvedAtMs > MAX_APPROVAL_LIFETIME_MS
    ) {
      return false;
    }
    return true;
  } catch {
    // error-policy:J3 Approval inputs are untrusted and invalid input fails closed.
    return false;
  }
}

export class NoOpExecutionAdapter {
  evaluate(
    plan: PaperDryRunPlan,
    intent: PaperApprovalIntent | undefined,
    nowMs: number,
  ): NoOpExecutionReceipt {
    try {
      const safePlanHash =
        isRecord(plan) && typeof plan.planHash === "string"
          ? plan.planHash
          : "0".repeat(64);
      const recomputedHash = recomputePlanHash(plan);
      if (
        !recomputedHash ||
        !SHA256.test(safePlanHash) ||
        recomputedHash !== safePlanHash
      ) {
        return {
          mode: "PAPER_DRY_RUN",
          planHash: safePlanHash,
          approvalStatus: "APPROVAL_INVALID",
          executed: false,
          reason: "INVALID_APPROVAL_INTENT",
        };
      }
      if (!intent) {
        return {
          mode: "PAPER_DRY_RUN",
          planHash: safePlanHash,
          approvalStatus: "APPROVAL_REQUIRED",
          executed: false,
          reason: "APPROVAL_REQUIRED",
        };
      }
      if (intent.decision === "REJECT") {
        return {
          mode: "PAPER_DRY_RUN",
          planHash: safePlanHash,
          approvalStatus: "APPROVAL_REJECTED",
          executed: false,
          reason: "APPROVAL_REJECTED",
        };
      }
      if (!validatePaperApprovalIntent(plan, intent, nowMs)) {
        return {
          mode: "PAPER_DRY_RUN",
          planHash: safePlanHash,
          approvalStatus: "APPROVAL_INVALID",
          executed: false,
          reason: "INVALID_APPROVAL_INTENT",
        };
      }
      return {
        mode: "PAPER_DRY_RUN",
        planHash: safePlanHash,
        approvalStatus: "APPROVAL_BOUND",
        executed: false,
        reason: "LIVE_EXECUTION_UNAVAILABLE_BY_DESIGN",
      };
    } catch {
      // error-policy:J1 This no-op boundary translates every malformed input to denial.
      return {
        mode: "PAPER_DRY_RUN",
        planHash: "0".repeat(64),
        approvalStatus: "APPROVAL_INVALID",
        executed: false,
        reason: "INVALID_APPROVAL_INTENT",
      };
    }
  }
}
