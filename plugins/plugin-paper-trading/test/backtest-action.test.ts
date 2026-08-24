import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  paperTradingAction,
  PaperTradingEngine,
  type HistoricalPrice,
} from "../src/index.js";

const DAY = 86_400_000;
const START = 1_770_000_000_000;

function history(): HistoricalPrice[] {
  return Array.from({ length: 30 }, (_, index) => ({
    observedAtMs: START + index * DAY,
    priceMicros: BigInt(50_000 + index * 100) * 1_000_000n,
  }));
}

describe("paper backtest action", () => {
  it("returns evidence and leaves the persistent paper ledger unchanged", async () => {
    const engine = new PaperTradingEngine();
    const before = engine.snapshot();
    const service = {
      publicHistory: async () => history(),
      snapshot: () => engine.snapshot(),
    };
    const runtime = {
      getService: () => service,
    } as unknown as IAgentRuntime;

    const result = await paperTradingAction.handler(
      runtime,
      {} as Memory,
      undefined,
      {
        parameters: { operation: "backtest", symbol: "BTC", days: 30 },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("PAPER BACKTEST / RESEARCH ONLY");
    expect(result.text).toContain("Evidence SHA-256:");
    expect(result.text).not.toContain("undefined");
    expect(result.data).toMatchObject({
      actionName: "PAPER_TRADING",
      mode: "PAPER_BACKTEST",
      operation: "backtest",
      symbol: "BTC",
      days: 30,
    });
    expect(engine.snapshot()).toEqual(before);
  });

  it("rejects unsupported symbols before reading history", async () => {
    let called = false;
    const runtime = {
      getService: () => ({
        publicHistory: async () => {
          called = true;
          return history();
        },
      }),
    } as unknown as IAgentRuntime;

    const result = await paperTradingAction.handler(
      runtime,
      {} as Memory,
      undefined,
      {
        parameters: { operation: "backtest", symbol: "DOGE", days: 30 },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(called).toBe(false);
  });
});
