import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { getPaperTradingService } from "./service.js";

export const paperTradingProvider: Provider = {
  name: "PAPER_TRADING_PORTFOLIO",
  description:
    "The owner's wallet-free simulated paper portfolio and risk status.",
  descriptionCompressed: "paper-only portfolio and risk status",
  position: -4,
  contexts: ["general"],
  roleGate: { minRole: "OWNER" },
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    try {
      const snapshot = getPaperTradingService(runtime).snapshot();
      return {
        text: [
          "# Paper trading portfolio",
          "SIMULATION ONLY. This is not a wallet, exchange account, live position, or evidence of profit.",
          `Cash micros: ${snapshot.cashMicros}`,
          `Equity micros: ${snapshot.equityMicros}`,
          `Gross exposure micros: ${snapshot.grossExposureMicros}`,
          `Realized P&L micros: ${snapshot.realizedPnlMicros}`,
          `Risk halt: ${snapshot.halted}`,
          `Positions: ${snapshot.positions.length}`,
          `Audit chain valid: ${getPaperTradingService(runtime).verifyAuditChain()}`,
        ].join("\n"),
        values: {
          paperTradingAvailable: true,
          paperTradingMode: "PAPER",
          paperPositionCount: snapshot.positions.length,
          paperTradingHalted: snapshot.halted,
        },
        data: { paperTrading: snapshot },
      };
    } catch (error) {
      runtime.reportError("paper-trading.provider", error);
      return {
        text:
          "PAPER TRADING: unavailable. Do not infer a zero balance or claim that a simulated order was recorded.",
        values: {
          paperTradingAvailable: false,
          paperTradingMode: "PAPER",
        },
        data: { paperTrading: null },
      };
    }
  },
};

export default paperTradingProvider;
