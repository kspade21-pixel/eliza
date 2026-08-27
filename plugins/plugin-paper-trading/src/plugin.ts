import type { Plugin } from "@elizaos/core";
import { paperTradingAction } from "./action.js";
import { paperTradingProvider } from "./provider.js";
import { PAPER_TRADING_SERVICE_TYPE, PaperTradingService } from "./service.js";

export const paperTradingPlugin: Plugin = {
  name: "@elizaos/plugin-paper-trading",
  description:
    "Owner-only wallet-free deterministic paper-trading simulation with strict risk controls.",
  actions: [paperTradingAction],
  providers: [paperTradingProvider],
  services: [PaperTradingService],
  async dispose(runtime) {
    await runtime
      .getService<PaperTradingService>(PAPER_TRADING_SERVICE_TYPE)
      ?.stop();
  },
};

export default paperTradingPlugin;
