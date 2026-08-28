import { homedir } from "node:os";
import path from "node:path";
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { PaperTradingEngine } from "./engine.js";
import { CoinGeckoKeylessQuoteSource } from "./market-data.js";
import { PaperStateStore } from "./state-store.js";
import type { PaperOrder, PaperSnapshot } from "./types.js";

export const PAPER_TRADING_SERVICE_TYPE = "paper_trading";

export class PaperTradingService extends Service {
  static override readonly serviceType = PAPER_TRADING_SERVICE_TYPE;

  override capabilityDescription =
    "Wallet-free deterministic paper-trading ledger and risk engine.";

  engine: PaperTradingEngine;
  readonly quoteSource: CoinGeckoKeylessQuoteSource;
  readonly stateStore: PaperStateStore;

  constructor(
    runtime?: IAgentRuntime,
    stateStore?: PaperStateStore,
    quoteSource = new CoinGeckoKeylessQuoteSource(),
  ) {
    super(runtime);
    const agentId = runtime ? String(runtime.agentId) : "default";
    this.stateStore =
      stateStore ??
      new PaperStateStore(
        path.join(
          homedir(),
          ".local",
          "state",
          "eliza",
          "paper-trading",
          `${agentId}.json`,
        ),
      );
    this.quoteSource = quoteSource;
    const stored = this.stateStore.load();
    this.engine = stored
      ? PaperTradingEngine.fromState(stored)
      : new PaperTradingEngine();
    if (!stored) this.stateStore.save(this.engine.exportState());
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PaperTradingService> {
    const agentId = String(runtime.agentId);
    const stateStore = new PaperStateStore(
      path.join(
        homedir(),
        ".local",
        "state",
        "eliza",
        "paper-trading",
        `${agentId}.json`,
      ),
    );
    const service = new PaperTradingService(runtime, stateStore);
    logger.info(
      { src: "plugin-paper-trading", ...service.snapshot() },
      "[PaperTradingService] Ready",
    );
    return service;
  }

  execute(order: PaperOrder) {
    const candidate = PaperTradingEngine.fromState(this.engine.exportState());
    const receipt = candidate.execute(order);
    this.stateStore.save(candidate.exportState());
    this.engine = candidate;
    return receipt;
  }

  async publicQuote(symbol: string) {
    return this.quoteSource.quote(symbol);
  }

  async publicHistory(symbol: string, days: 30 | 90 | 180 | 365) {
    return this.quoteSource.history(symbol, days);
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
