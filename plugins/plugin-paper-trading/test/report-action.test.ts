import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { paperTradingAction, PaperTradingEngine } from "../src/index.js";

describe("paper performance and risk report", () => {
  it("reports a healthy read-only ledger without mutating it", async () => {
    const engine = new PaperTradingEngine();
    const before = engine.exportState();
    const runtime = {
      getService: () => ({
        snapshot: () => engine.snapshot(),
        verifyAuditChain: () => engine.verifyAuditChain(),
      }),
    } as unknown as IAgentRuntime;

    const result = await paperTradingAction.handler(
      runtime,
      {} as Memory,
      undefined,
      { parameters: { operation: "report" } } as HandlerOptions,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error("paper report action returned no result");
    expect(result.success).toBe(true);
    expect(result.text).toContain("PAPER PERFORMANCE / RISK REPORT");
    expect(result.text).toContain("Audit chain: valid");
    expect(result.text).toContain("Risk alerts: none");
    expect(result.data).toMatchObject({
      actionName: "PAPER_TRADING",
      mode: "PAPER_REPORT",
      operation: "report",
      auditChainValid: true,
      riskAlerts: [],
    });
    expect(engine.exportState()).toEqual(before);
  });

  it("fails closed when the audit chain is invalid", async () => {
    const engine = new PaperTradingEngine();
    const runtime = {
      getService: () => ({
        snapshot: () => engine.snapshot(),
        verifyAuditChain: () => false,
      }),
    } as unknown as IAgentRuntime;

    const result = await paperTradingAction.handler(
      runtime,
      {} as Memory,
      undefined,
      { parameters: { operation: "report" } } as HandlerOptions,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error("paper report action returned no result");
    expect(result.success).toBe(false);
    expect(result.error).toBe("PAPER_AUDIT_CHAIN_INVALID");
    expect(result.text).toContain("AUDIT_CHAIN_INVALID");
  });
});
