import { describe, expect, it } from "vitest";
import {
  buildPaperDryRunPlan,
  NoOpExecutionAdapter,
  PaperTradingEngine,
  validatePaperApprovalIntent,
  type PaperApprovalIntent,
  type PaperOrder,
} from "../src/index.js";

const NOW = 1_787_545_600_000;

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    idempotencyKey: "dry-run-1",
    side: "buy",
    symbol: "BTC",
    quantityAtomic: 1_000n,
    quote: {
      symbol: "BTC",
      priceMicros: 50_000_000_000n,
      observedAtMs: NOW - 1_000,
      source: "verified-test-fixture",
    },
    requestedAtMs: NOW,
    ...overrides,
  };
}

function approval(
  planHash: string,
  overrides: Partial<PaperApprovalIntent> = {},
): PaperApprovalIntent {
  return {
    schemaVersion: 1,
    mode: "PAPER_DRY_RUN",
    decision: "APPROVE_SIMULATION",
    planHash,
    intentId: "intent-1",
    approvedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

describe("paper launch readiness", () => {
  it("builds a deterministic risk-checked plan without mutating the source state", () => {
    const engine = new PaperTradingEngine();
    const before = engine.exportState();
    const first = buildPaperDryRunPlan(before, order());
    const second = buildPaperDryRunPlan(before, order());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: "PAPER_DRY_RUN",
      executed: false,
      projectedReceipt: {
        accepted: true,
        reason: "SIMULATED_FILL",
      },
    });
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(engine.exportState()).toEqual(before);
    expect(engine.snapshot().auditLength).toBe(0);
  });

  it("uses the existing risk engine and fails closed for stale input", () => {
    const engine = new PaperTradingEngine();
    const plan = buildPaperDryRunPlan(
      engine.exportState(),
      order({
        quote: {
          symbol: "BTC",
          priceMicros: 50_000_000_000n,
          observedAtMs: NOW - 300_001,
          source: "verified-test-fixture",
        },
      }),
    );

    expect(plan.projectedReceipt).toMatchObject({
      accepted: false,
      reason: "STALE_OR_FUTURE_QUOTE",
    });
    expect(engine.snapshot()).toMatchObject({
      cashMicros: "20000000",
      positions: [],
      auditLength: 0,
    });
  });

  it("binds approval to the exact plan but never executes", () => {
    const plan = buildPaperDryRunPlan(
      new PaperTradingEngine().exportState(),
      order(),
    );
    const intent = approval(plan.planHash);
    expect(validatePaperApprovalIntent(plan, intent, NOW)).toBe(true);

    expect(new NoOpExecutionAdapter().evaluate(plan, intent, NOW)).toEqual({
      mode: "PAPER_DRY_RUN",
      planHash: plan.planHash,
      approvalStatus: "APPROVAL_BOUND",
      executed: false,
      reason: "LIVE_EXECUTION_UNAVAILABLE_BY_DESIGN",
    });
  });

  it("requires approval and rejects mismatched, expired, future, and rejected intents", () => {
    const plan = buildPaperDryRunPlan(
      new PaperTradingEngine().exportState(),
      order(),
    );
    const adapter = new NoOpExecutionAdapter();

    expect(adapter.evaluate(plan, undefined, NOW)).toMatchObject({
      executed: false,
      reason: "APPROVAL_REQUIRED",
    });
    expect(
      adapter.evaluate(plan, approval("0".repeat(64)), NOW),
    ).toMatchObject({
      executed: false,
      reason: "INVALID_APPROVAL_INTENT",
    });
    expect(
      adapter.evaluate(
        plan,
        approval(plan.planHash, {
          approvedAtMs: NOW - 120_000,
          expiresAtMs: NOW - 1,
        }),
        NOW,
      ),
    ).toMatchObject({
      executed: false,
      reason: "INVALID_APPROVAL_INTENT",
    });
    expect(
      adapter.evaluate(
        plan,
        approval(plan.planHash, {
          approvedAtMs: NOW + 1,
          expiresAtMs: NOW + 60_000,
        }),
        NOW,
      ),
    ).toMatchObject({
      executed: false,
      reason: "INVALID_APPROVAL_INTENT",
    });
    expect(
      adapter.evaluate(
        plan,
        approval(plan.planHash, { decision: "REJECT" }),
        NOW,
      ),
    ).toMatchObject({
      executed: false,
      reason: "APPROVAL_REJECTED",
    });
  });

  it("changes the plan hash when any order-bound input changes", () => {
    const state = new PaperTradingEngine().exportState();
    const baseline = buildPaperDryRunPlan(state, order());
    const changed = buildPaperDryRunPlan(
      state,
      order({ quantityAtomic: 1_001n }),
    );
    expect(changed.planHash).not.toBe(baseline.planHash);
  });
});
