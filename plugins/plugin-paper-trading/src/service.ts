import {
  ElizaError,
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import { PaperTradingEngine } from "./engine.js";
import type { PaperOrder, PaperSnapshot } from "./types.js";

export const PAPER_TRADING_SERVICE_TYPE = "paper_trading";

export class PaperTradingService extends Service {
  static override readonly serviceType = PAPER_TRADING_SERVICE_TYPE;

  override capabilityDescription =
    "Wallet-free deterministic paper-trading ledger and risk engine.";

  readonly engine: PaperTradingEngine;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.engine = new PaperTradingEngine();
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PaperTradingService> {
    const service = new PaperTradingService(runtime);
    logger.info(
      { src: "plugin-paper-trading", mode: "PAPER", cashMicros: "20000000" },
      "[PaperTradingService] Ready",
    );
    return service;
  }

  execute(order: PaperOrder) {
    return this.engine.execute(order);
  }

  snapshot(): PaperSnapshot {
    return this.engine.snapshot();
  }

  verifyAuditChain(): boolean {
    return this.engine.verifyAuditChain();
  }

  override async stop(): Promise<void> {
    logger.info(
      { src: "plugin-paper-trading" },
      "[PaperTradingService] Stopped",
    );
  }
}

export function getPaperTradingService(
  runtime: IAgentRuntime,
): PaperTradingService {
  const service = runtime.getService<PaperTradingService>(
    PAPER_TRADING_SERVICE_TYPE,
  );
  if (!service) {
    throw new ElizaError(
      "Paper-trading service is not registered or has not finished loading.",
      {
        code: "PAPER_TRADING_SERVICE_UNAVAILABLE",
        severity: "ephemeral",
      },
    );
  }
  return service;
}
