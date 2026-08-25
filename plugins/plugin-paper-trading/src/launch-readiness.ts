import { createHash } from "node:crypto";
import { PaperTradingEngine } from "./engine.js";
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

function canonicalPlanInput(
  order: PaperOrder,
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
  const previewEngine = PaperTradingEngine.fromState(state, policy);
  const snapshotBefore = previewEngine.snapshot();
  const projectedReceipt = previewEngine.execute(order);
  const normalized = canonicalPlanInput(order, snapshotBefore, projectedReceipt);
  const planHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  return Object.freeze({
    ...(normalized as Omit<PaperDryRunPlan, "planHash">),
    planHash,
  });
}

export function validatePaperApprovalIntent(
  plan: PaperDryRunPlan,
  intent: PaperApprovalIntent,
  nowMs: number,
): boolean {
  if (
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
}

export class NoOpExecutionAdapter {
  evaluate(
    plan: PaperDryRunPlan,
    intent: PaperApprovalIntent | undefined,
    nowMs: number,
  ): NoOpExecutionReceipt {
    if (!intent) {
      return {
        mode: "PAPER_DRY_RUN",
        planHash: plan.planHash,
        approvalStatus: "APPROVAL_REQUIRED",
        executed: false,
        reason: "APPROVAL_REQUIRED",
      };
    }
    if (intent.decision === "REJECT") {
      return {
        mode: "PAPER_DRY_RUN",
        planHash: plan.planHash,
        approvalStatus: "APPROVAL_REJECTED",
        executed: false,
        reason: "APPROVAL_REJECTED",
      };
    }
    if (!validatePaperApprovalIntent(plan, intent, nowMs)) {
      return {
        mode: "PAPER_DRY_RUN",
        planHash: plan.planHash,
        approvalStatus: "APPROVAL_INVALID",
        executed: false,
        reason: "INVALID_APPROVAL_INTENT",
      };
    }
    return {
      mode: "PAPER_DRY_RUN",
      planHash: plan.planHash,
      approvalStatus: "APPROVAL_BOUND",
      executed: false,
      reason: "LIVE_EXECUTION_UNAVAILABLE_BY_DESIGN",
    };
  }
}
