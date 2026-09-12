#!/usr/bin/env node
/**
 * Emits the machine-readable health record that external agents poll to decide
 * whether the paper-trading lane is trustworthy right now.
 *
 * Consumers are bots, not people: the contract is a stable JSON shape at a
 * stable location, so a reader never has to scrape Actions HTML or hold a
 * GitHub token. Every field is either a fact about the run that produced it or
 * an explicitly unavailable marker — a lane whose result was never reported
 * reads as "unknown" and forces `overall` to "red", because a status feed that
 * degrades a missing signal into a passing one is worse than no feed.
 *
 * The `execution` block is a safety invariant, not telemetry. This repository
 * is paper-only: the sole execution adapter is `NoOpExecutionAdapter`, which
 * records intent and places nothing. This script verifies that adapter is still
 * the exported execution surface and fails the record if a live order path has
 * appeared, so an agent reading the feed cannot be handed a green light for a
 * system that quietly started trading real money.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { assertContainedRegularFile } from "./lib/repository-file-integrity.mjs";

const SCHEMA = "eliza-paper-status/1";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const NO_OP_ADAPTER = "NoOpExecutionAdapter";
const PAPER_PACKAGE_NAME = "@elizaos/plugin-paper-trading";
const PAPER_PACKAGE_DIR = "plugins/plugin-paper-trading";
const CANONICAL_SOURCE_ENTRY = "./src/index.ts";
const CANONICAL_READINESS_EXPORT = "./launch-readiness.js";
const CANONICAL_READINESS_SOURCE = "src/launch-readiness.ts";
const PAPER_BUILD_CONFIG = `${PAPER_PACKAGE_DIR}/tsconfig.build.json`;
const SHARED_BUILD_CONFIG = "plugins/tsconfig.build.shared.json";
const EXPECTED_EXECUTION_CLOSURE_SHA256 =
  "db9de9da412ade4ddcbe0cb27ef9317cb4f1cdcf5db6af8ea4ee05bba1bdebfc";
export const PAPER_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const REQUIRED_PAPER_LANES = Object.freeze([
  "install",
  "build-core",
  "paper-typecheck",
  "paper-tests",
  "status-contract",
  "sdk-routes",
]);

/** Names that would indicate a real order path replaced the no-op adapter. */
const LIVE_EXECUTION_MARKERS = [
  "createOrder",
  "submitOrder",
  "placeOrder",
  "sendTransaction",
  "signAndSend",
];

/** Runtime capabilities that the paper execution closure must never reach. */
const FORBIDDEN_EXECUTION_CAPABILITIES = new Set([
  "BroadcastChannel",
  "Bun",
  "Deno",
  "EventSource",
  "Function",
  "Image",
  "Proxy",
  "Reflect",
  "SharedWorker",
  "WebAssembly",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "document",
  "eval",
  "fetch",
  "global",
  "globalThis",
  "localStorage",
  "location",
  "module",
  "navigator",
  "open",
  "postMessage",
  "process",
  "require",
  "self",
  "sendBeacon",
  "sessionStorage",
  "window",
  ...LIVE_EXECUTION_MARKERS,
]);

const ALLOWED_EXECUTION_RUNTIME_IMPORTS = new Map([
  ["node:crypto", new Set(["createHash"])],
]);

const ALLOWED_EXECUTION_RELATIVE_IMPORTS = new Map([
  [
    `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
    new Map([
      ["./engine.js", new Set(["DEFAULT_PAPER_POLICY", "PaperTradingEngine"])],
    ]),
  ],
  [
    `${PAPER_PACKAGE_DIR}/src/engine.ts`,
    new Map([["./types.js", new Set(["ASSET_SCALE", "BPS_SCALE"])]]),
  ],
]);

const ALLOWED_PUBLIC_RUNTIME_EXPORTS = new Map([
  ["./action.js", new Set(["formatUsdMicros", "paperTradingAction"])],
  ["./backtest.js", new Set(["DEFAULT_BACKTEST_POLICY", "runPaperBacktest"])],
  ["./engine.js", new Set(["DEFAULT_PAPER_POLICY", "PaperTradingEngine"])],
  [
    "./evaluation.js",
    new Set([
      "DEFAULT_WALK_FORWARD_POLICY",
      "hashPaperWalkForwardConfiguration",
      "hashPublicHistoricalDataset",
      "MAX_WALK_FORWARD_FOLDS",
      "runPaperWalkForwardEvaluation",
    ]),
  ],
  [
    CANONICAL_READINESS_EXPORT,
    new Set([
      "buildPaperDryRunPlan",
      NO_OP_ADAPTER,
      "validatePaperApprovalIntent",
    ]),
  ],
  ["./market-data.js", new Set(["CoinGeckoKeylessQuoteSource"])],
  [
    "./plugin.js",
    new Set(["paperTradingPlugin", "paperTradingPlugin as default"]),
  ],
  ["./provider.js", new Set(["paperTradingProvider"])],
  [
    "./service.js",
    new Set([
      "getPaperTradingService",
      "PAPER_TRADING_SERVICE_TYPE",
      "PaperTradingService",
    ]),
  ],
  ["./state-store.js", new Set(["PaperStateStore"])],
  ["./types.js", new Set(["ASSET_SCALE", "BPS_SCALE", "USD_SCALE"])],
]);

const REQUIRED_PAPER_BUILD_OPTIONS = Object.freeze({
  allowImportingTsExtensions: false,
  declaration: true,
  declarationMap: true,
  emitDeclarationOnly: false,
  noEmit: false,
  outDir: "dist",
  rootDir: "src",
  rewriteRelativeImportExtensions: true,
});

function validatePaperBuildConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${PAPER_BUILD_CONFIG} must contain a JSON object`);
  }
  const expectedTopLevelNames = [
    "compilerOptions",
    "exclude",
    "extends",
    "include",
  ];
  if (
    JSON.stringify(Object.keys(config).sort()) !==
    JSON.stringify(expectedTopLevelNames)
  ) {
    throw new Error(
      `${PAPER_BUILD_CONFIG} must contain only the reviewed top-level options`,
    );
  }
  if (config.extends !== "../tsconfig.build.shared.json") {
    throw new Error(
      `${PAPER_BUILD_CONFIG} must extend ../tsconfig.build.shared.json`,
    );
  }
  if (JSON.stringify(config.include) !== JSON.stringify(["src/**/*.ts"])) {
    throw new Error(`${PAPER_BUILD_CONFIG} must include only src/**/*.ts`);
  }
  if (JSON.stringify(config.exclude) !== JSON.stringify(["test/**/*.ts"])) {
    throw new Error(`${PAPER_BUILD_CONFIG} must exclude only test/**/*.ts`);
  }
  const options = config.compilerOptions;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${PAPER_BUILD_CONFIG} must declare compilerOptions`);
  }
  const expectedNames = Object.keys(REQUIRED_PAPER_BUILD_OPTIONS).sort();
  const actualNames = Object.keys(options).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${PAPER_BUILD_CONFIG} compilerOptions must contain only the reviewed build options`,
    );
  }
  for (const [name, expected] of Object.entries(REQUIRED_PAPER_BUILD_OPTIONS)) {
    if (options[name] !== expected) {
      throw new Error(
        `${PAPER_BUILD_CONFIG} compilerOptions.${name} must equal ${JSON.stringify(expected)}`,
      );
    }
  }
}

function hasRuntimeImport(importClause) {
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  const bindings = importClause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return (
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function hasRuntimeExport(exportDeclaration) {
  if (exportDeclaration.isTypeOnly) return false;
  const clause = exportDeclaration.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return true;
  return (
    clause.elements.length === 0 ||
    clause.elements.some((element) => !element.isTypeOnly)
  );
}

function runtimeImportNames(statement) {
  if (!ts.isImportDeclaration(statement)) return null;
  const clause = statement.importClause;
  if (
    !clause ||
    clause.isTypeOnly ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return null;
  }
  return clause.namedBindings.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
}

function assertNoRuntimeShadow(repoRoot, runtimePath) {
  try {
    lstatSync(resolve(repoRoot, ...runtimePath.split("/")));
  } catch (cause) {
    // error-policy:J3 A missing emitted-specifier file is the expected source layout.
    if (cause?.code === "ENOENT") return;
    throw cause;
  }
  throw new Error(
    `runtime-resolvable source ${runtimePath} shadows its TypeScript source`,
  );
}

function resolveExecutionImport(repoRoot, modulePath, specifier) {
  const sourceRoot = `${PAPER_PACKAGE_DIR}/src`;
  const joined = posix.normalize(
    posix.join(posix.dirname(modulePath), specifier),
  );
  if (!joined.startsWith(`${sourceRoot}/`)) {
    throw new Error(`runtime import escapes ${sourceRoot}`);
  }
  if (joined.endsWith(".js")) {
    assertNoRuntimeShadow(repoRoot, joined);
    return `${joined.slice(0, -3)}.ts`;
  }
  if (joined.endsWith(".mjs")) {
    assertNoRuntimeShadow(repoRoot, joined);
    return `${joined.slice(0, -4)}.mts`;
  }
  if (joined.endsWith(".cjs")) {
    assertNoRuntimeShadow(repoRoot, joined);
    return `${joined.slice(0, -4)}.cts`;
  }
  if (joined.endsWith(".jsx")) {
    assertNoRuntimeShadow(repoRoot, joined);
    return `${joined.slice(0, -4)}.tsx`;
  }
  if (joined.endsWith(".ts")) return joined;
  if (
    joined.endsWith(".mts") ||
    joined.endsWith(".cts") ||
    joined.endsWith(".tsx")
  ) {
    return joined;
  }
  throw new Error(
    "runtime import must use an explicit .js, .mjs, .cjs, .jsx, or TypeScript suffix",
  );
}

function inspectAllowedRuntimeImport(statement, specifier, modulePath) {
  const allowedNames = ALLOWED_EXECUTION_RUNTIME_IMPORTS.get(specifier);
  if (!allowedNames) {
    return `Forbidden runtime dependency "${specifier}" found in ${modulePath}.`;
  }
  const importedNames = runtimeImportNames(statement);
  if (
    !importedNames ||
    importedNames.length === 0 ||
    importedNames.some((name) => !allowedNames.has(name))
  ) {
    return `Runtime dependency "${specifier}" must import only ${[
      ...allowedNames,
    ].join(", ")} in ${modulePath}.`;
  }
  return null;
}

function inspectAllowedRelativeRuntimeImport(statement, specifier, modulePath) {
  if (!ts.isImportDeclaration(statement)) {
    return `Runtime re-export "${specifier}" is forbidden in ${modulePath}.`;
  }
  const allowedNames =
    ALLOWED_EXECUTION_RELATIVE_IMPORTS.get(modulePath)?.get(specifier);
  const importedNames = runtimeImportNames(statement);
  if (
    !allowedNames ||
    !importedNames ||
    importedNames.length === 0 ||
    importedNames.some((name) => !allowedNames.has(name))
  ) {
    return `Non-allowlisted runtime dependency "${specifier}" found in ${modulePath}.`;
  }
  return null;
}

function inspectPublicRuntimeExports(sourceFile, modulePath, findings) {
  const seen = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !hasRuntimeExport(statement)) {
      continue;
    }
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      findings.add(
        `${modulePath} contains a non-allowlisted runtime re-export.`,
      );
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const allowed = ALLOWED_PUBLIC_RUNTIME_EXPORTS.get(specifier);
    if (statement.exportClause.elements.length === 0) {
      findings.add(
        `${modulePath} contains an empty runtime re-export from ${specifier}.`,
      );
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      const exported = element.name.text;
      const identity =
        imported === exported ? imported : `${imported} as ${exported}`;
      const key = `${specifier}:${identity}`;
      if (!allowed?.has(identity) || seen.has(key)) {
        findings.add(
          `${modulePath} contains a non-allowlisted runtime re-export ${key}.`,
        );
      }
      seen.add(key);
    }
  }
}

function inspectModuleCapabilities(sourceFile, modulePath, findings) {
  const seenCapabilities = new Set();
  const isNonRuntimeName = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      "name" in parent &&
      parent.name === node &&
      (ts.isBindingElement(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isVariableDeclaration(parent))
    ) {
      return true;
    }
    return false;
  };
  const collectBindingNames = (name, names) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingNames(element.name, names);
      }
    }
  };
  const rootIdentifier = (expression) => {
    let current = expression;
    while (true) {
      if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      break;
    }
    return ts.isIdentifier(current) ? current.text : null;
  };
  const allowedParameterMemberCalls = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "encodeNumber|value.toString|0",
        "normalizePolicy|policy.initialCashMicros.toString|0",
        "normalizePolicy|policy.maxOrderMicros.toString|0",
        "normalizePolicy|policy.maxSymbolExposureMicros.toString|0",
        "normalizePolicy|policy.maxGrossExposureMicros.toString|0",
        "normalizePolicy|policy.minCashReserveMicros.toString|0",
        "normalizePolicy|policy.maxDailyLossMicros.toString|0",
        "normalizePolicy|policy.feeBps.toString|0",
        "normalizePolicy|policy.slippageBps.toString|0",
        "normalizePolicy|policy.symbolAllowlist.some|1",
        "normalizePolicy|policy.symbolAllowlist.map|1",
        "normalizePolicy|symbol.trim|0",
        "normalizePolicy|symbol.trim().toUpperCase|0",
        "assertOrder|order.idempotencyKey.trim|0",
        "assertOrder|order.symbol.trim|0",
        "duplicateReceipt|order.symbol.trim|0",
        "duplicateReceipt|order.symbol.trim().toUpperCase|0",
        "duplicateReceipt|order.quantityAtomic.toString|0",
        "duplicateReceipt|order.quote.priceMicros.toString|0",
        "canonicalPlanInput|order.symbol.trim|0",
        "canonicalPlanInput|order.symbol.trim().toUpperCase|0",
        "canonicalPlanInput|order.quantityAtomic.toString|0",
        "canonicalPlanInput|order.quote.priceMicros.toString|0",
        "buildPaperDryRunPlan|state.audit.some|1",
        "buildPaperDryRunPlan|PaperTradingEngine.fromState|2",
        "buildPaperDryRunPlan|previewEngine.snapshot|0",
        "buildPaperDryRunPlan|previewEngine.execute|1",
        "isValidSnapshot|snapshot.positions.every|1",
        "isValidSnapshot|position.symbol.trim|0",
        "isValidSnapshot|position.symbol.trim().toUpperCase|0",
        "recomputePlanHash|order.idempotencyKey.trim|0",
        "recomputePlanHash|order.symbol.trim|0",
        "recomputePlanHash|order.quoteSource.trim|0",
        "recomputePlanHash|policy.symbolAllowlist.some|1",
        "recomputePlanHash|symbol.trim|0",
        "recomputePlanHash|symbol.trim().toUpperCase|0",
        "recomputePlanHash|replayPolicy.symbolAllowlist.includes|1",
        "recomputePlanHash|replayEngine.ledger.positions.has|1",
        "recomputePlanHash|replayEngine.ledger.positions.set|2",
        "recomputePlanHash|replayEngine.snapshot|0",
        "recomputePlanHash|replayEngine.execute|1",
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "encodeNumber|value.toString|0",
        "policyCommitment|policy.initialCashMicros.toString|0",
        "policyCommitment|policy.maxOrderMicros.toString|0",
        "policyCommitment|policy.maxSymbolExposureMicros.toString|0",
        "policyCommitment|policy.maxGrossExposureMicros.toString|0",
        "policyCommitment|policy.minCashReserveMicros.toString|0",
        "policyCommitment|policy.maxDailyLossMicros.toString|0",
        "policyCommitment|policy.feeBps.toString|0",
        "policyCommitment|policy.slippageBps.toString|0",
        "constructor|policy.symbolAllowlist.map|1",
        "constructor|symbol.trim|0",
        "constructor|symbol.trim().toUpperCase|0",
        "execute|order.symbol.trim|0",
        "execute|order.symbol.trim().toUpperCase|0",
        "execute|this.#receiptsByKey.get|1",
        "execute|this.#validateOrder|2",
        "execute|this.#record|5",
        "execute|this.#record|8",
        "execute|this.ledger.positions.set|2",
        "snapshot|position.quantityAtomic.toString|0",
        "snapshot|position.costBasisMicros.toString|0",
        "snapshot|position.lastMarkPriceMicros.toString|0",
        "exportState|position.quantityAtomic.toString|0",
        "exportState|position.costBasisMicros.toString|0",
        "exportState|position.lastMarkPriceMicros.toString|0",
        "fromState|engine.ledger.positions.clear|0",
        "fromState|stored.symbol.trim|0",
        "fromState|stored.symbol.trim().toUpperCase|0",
        "fromState|engine.policy.symbolAllowlist.includes|1",
        "fromState|engine.ledger.positions.has|1",
        "fromState|engine.ledger.positions.set|2",
        "fromState|engine.audit.splice|3",
        "fromState|state.audit.map|1",
        "fromState|engine.verifyAuditChain|0",
        "fromState|engine.audit.entries|0",
        "fromState|receipt.symbol.trim|0",
        "fromState|receipt.symbol.trim().toUpperCase|0",
        "fromState|receipt.idempotencyKey.trim|0",
        "fromState|engine.#receiptsByKey.has|1",
        "fromState|replayEngine.ledger.cashMicros.toString|0",
        "fromState|replayEngine.execute|1",
        "fromState|engine.#receiptsByKey.set|2",
        "fromState|replayEngine.ledger.positions.entries|0",
        "fromState|engine.ledger.positions.get|1",
        "fromState|engine.audit.at|1",
        "fromState|engine.ledger.cashMicros.toString|0",
        "#validateOrder|order.idempotencyKey.trim|0",
        "#validateOrder|order.quote.symbol.trim|0",
        "#validateOrder|order.quote.symbol.trim().toUpperCase|0",
        "#validateOrder|order.quote.source.trim|0",
        "#validateOrder|this.policy.symbolAllowlist.includes|1",
        "#record|order.quantityAtomic.toString|0",
        "#record|order.quote.priceMicros.toString|0",
        "#record|executionPrice.toString|0",
        "#record|notional.toString|0",
        "#record|fee.toString|0",
        "#record|cashBefore.toString|0",
        "#record|this.audit.push|1",
        "#record|this.#receiptsByKey.set|2",
      ]),
    ],
  ]);
  const staticMemberPath = (expression) => {
    if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isMetaProperty(expression)) {
      return `${expression.keywordToken === ts.SyntaxKind.ImportKeyword ? "import" : "new"}.${expression.name.text}`;
    }
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = staticMemberPath(expression.expression);
      return receiver ? `${receiver}.${expression.name.text}` : null;
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = staticMemberPath(expression.expression);
      const member = staticStringValue(expression.argumentExpression);
      return receiver && member !== null ? `${receiver}.${member}` : null;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return staticMemberPath(expression.expression);
    }
    if (ts.isCallExpression(expression) && expression.arguments.length === 0) {
      const callee = staticMemberPath(expression.expression);
      return callee ? `${callee}()` : null;
    }
    return null;
  };
  const staticStringValue = (expression) => {
    const value = unwrapExpression(expression);
    if (
      ts.isStringLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value)
    ) {
      return value.text;
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticStringValue(value.left);
      const right = staticStringValue(value.right);
      return left === null || right === null ? null : `${left}${right}`;
    }
    if (ts.isTemplateExpression(value)) {
      let result = value.head.text;
      for (const span of value.templateSpans) {
        const part = staticStringValue(span.expression);
        if (part === null) return null;
        result += `${part}${span.literal.text}`;
      }
      return result;
    }
    return null;
  };
  const expectedNamedFunctionParameters = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Map([
        ["encodeNumber", ["value"]],
        ["normalizePolicy", ["policy"]],
        ["assertOrder", ["order"]],
        ["duplicateReceipt", ["order", "snapshot"]],
        [
          "canonicalPlanInput",
          ["order", "effectivePolicy", "snapshotBefore", "projectedReceipt"],
        ],
        ["buildPaperDryRunPlan", ["state", "order", "policy"]],
        ["isValidSnapshot", ["snapshot"]],
        ["recomputePlanHash", ["plan"]],
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Map([
        ["encodeNumber", ["value"]],
        ["policyCommitment", ["policy"]],
        ["constructor", ["policy"]],
        ["execute", ["order"]],
        ["fromState", ["state", "policy"]],
        ["#validateOrder", ["order", "symbol"]],
        [
          "#record",
          [
            "order",
            "symbol",
            "cashBefore",
            "accepted",
            "reason",
            "executionPrice",
            "notional",
            "fee",
          ],
        ],
      ]),
    ],
  ]);
  const allowedReceiverOrigins = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Map([
        [
          "buildPaperDryRunPlan|previewEngine",
          new Set(["@PaperTradingEngine"]),
        ],
        ["recomputePlanHash|order", new Set(["plan.order"])],
        ["recomputePlanHash|policy", new Set(["plan.effectivePolicy"])],
        ["recomputePlanHash|replayPolicy", new Set(["@NormalizedPaperPolicy"])],
        ["recomputePlanHash|replayEngine", new Set(["@PaperTradingEngine"])],
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Map([
        ["fromState|engine", new Set(["@PaperTradingEngine"])],
        ["fromState|stored", new Set(["state.positions[]"])],
        [
          "fromState|receipt",
          new Set(["@PaperTradingEngine.audit.entries()[]"]),
        ],
        ["fromState|replayEngine", new Set(["@PaperTradingEngine"])],
      ]),
    ],
  ]);
  const allowedTrustedReceiverWrites = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "recomputePlanHash|replayEngine.ledger.cashMicros",
        "recomputePlanHash|replayEngine.ledger.realizedPnlMicros",
        "recomputePlanHash|replayEngine.ledger.halted",
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "fromState|engine.ledger.cashMicros",
        "fromState|engine.ledger.realizedPnlMicros",
        "fromState|engine.ledger.halted",
      ]),
    ],
  ]);
  const allowedComputedReads = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "normalizePolicy|policy|field",
        "recomputePlanHash|policy|field",
      ]),
    ],
  ]);
  const allowedParameterIterables = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "deepFreeze|Object.values(value)",
        "recomputePlanHash|plan.snapshotBefore.positions",
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "verifyAuditChain|this.audit",
        "fromState|state.positions",
        "fromState|engine.audit.entries()",
        "#grossExposureMicros|this.ledger.positions.values()",
      ]),
    ],
  ]);
  const allowedParameterSpreads = new Map([
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "policyCommitment|policy.symbolAllowlist",
        "snapshot|this.ledger.positions.values()",
        "exportState|this.ledger.positions.values()",
        "fromState|state.audit.map()",
        "fromState|replayEngine.ledger.positions.entries()",
      ]),
    ],
  ]);
  const protectedRuntimeBindings = new Set([
    "Array",
    "BigInt",
    "Error",
    "JSON",
    "Map",
    "Number",
    "Object",
    "PaperTradingEngine",
    "Set",
    "String",
    "createHash",
  ]);
  const mutationHelpers = new Set([
    "Object.assign",
    "Object.create",
    "Object.defineProperties",
    "Object.defineProperty",
    "Object.getOwnPropertyDescriptor",
    "Object.getOwnPropertyDescriptors",
    "Object.getPrototypeOf",
    "Object.setPrototypeOf",
  ]);
  const forbiddenMutationMembers = new Set([
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  ]);
  const statefulMembers = new Set(["add", "push", "set", "splice", "unshift"]);
  const reviewedPureParameterArgumentCalls = new Set([
    "Array.isArray",
    "Number.isNaN",
    "Number.isSafeInteger",
    "Object.freeze",
    "Object.is",
    "Object.isFrozen",
    "Object.keys",
    "Object.prototype.hasOwnProperty.call",
    "Object.values",
  ]);
  const allowedParameterArgumentCalls = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "hashReceipt|JSON.stringify|receipt",
        "buildPaperDryRunPlan|JSON.stringify|normalized",
        "recomputePlanHash|JSON.stringify|reconstructedSnapshot.positions",
        "recomputePlanHash|JSON.stringify|plan.snapshotBefore.positions",
        "recomputePlanHash|JSON.stringify|expectedReceipt",
        "recomputePlanHash|JSON.stringify|plan.projectedReceipt",
        "recomputePlanHash|JSON.stringify|canonical",
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "sha256|JSON.stringify|value",
        "hashReceipt|JSON.stringify|receipt",
      ]),
    ],
  ]);
  const allowedParameterCoercions = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set([
        "decodeCanonicalSafeInteger|Number|value",
        "isValidSnapshot|BigInt|position.quantityAtomic",
        "isValidSnapshot|BigInt|position.costBasisMicros",
        "isValidSnapshot|BigInt|position.lastMarkPriceMicros",
        "recomputePlanHash|BigInt|policy.initialCashMicros",
        "recomputePlanHash|BigInt|policy.maxOrderMicros",
        "recomputePlanHash|BigInt|policy.maxSymbolExposureMicros",
        "recomputePlanHash|BigInt|policy.maxGrossExposureMicros",
        "recomputePlanHash|BigInt|policy.minCashReserveMicros",
        "recomputePlanHash|BigInt|policy.maxDailyLossMicros",
        "recomputePlanHash|BigInt|policy.feeBps",
        "recomputePlanHash|BigInt|policy.slippageBps",
        "recomputePlanHash|BigInt|plan.snapshotBefore.cashMicros",
        "recomputePlanHash|BigInt|plan.snapshotBefore.realizedPnlMicros",
        "recomputePlanHash|BigInt|position.quantityAtomic",
        "recomputePlanHash|BigInt|position.costBasisMicros",
        "recomputePlanHash|BigInt|position.lastMarkPriceMicros",
        "recomputePlanHash|BigInt|order.quantityAtomic",
        "recomputePlanHash|BigInt|order.quotePriceMicros",
      ]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set([
        "decodeCanonicalNumber|Number|value",
        "fromState|BigInt|value",
        "fromState|BigInt|receipt.quantityAtomic",
        "fromState|BigInt|receipt.quotePriceMicros",
      ]),
    ],
  ]);
  const reviewedStaticReceiverCalls = new Map([
    ["CANONICAL_INTEGER.test", "regexp"],
    ["INTEGER.test", "regexp"],
    ["INTENT_ID.test", "regexp"],
    ["PAPER_AUDIT_REASONS.has", "string-set"],
    ["PAPER_AUDIT_RECEIPT_KEYS.has", "string-set"],
    ["POSITIVE_DECIMAL.test", "regexp"],
    ["SHA256.test", "regexp"],
    ["UNSIGNED_DECIMAL.test", "regexp"],
  ]);
  const allowedConstructors = new Set([
    "Error",
    "Map",
    "PaperTradingEngine",
    "Set",
  ]);
  const allowedParameterConstructors = new Map([
    [
      `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}`,
      new Set(["recomputePlanHash|PaperTradingEngine|1"]),
    ],
    [
      `${PAPER_PACKAGE_DIR}/src/engine.ts`,
      new Set(["fromState|PaperTradingEngine|1"]),
    ],
  ]);
  const protectedCallableMembers = new Set(["fromState"]);
  for (const path of [
    ...reviewedPureParameterArgumentCalls,
    ...reviewedStaticReceiverCalls.keys(),
  ]) {
    const member = path.replace(/\(\)$/u, "").split(".").at(-1);
    if (member) protectedCallableMembers.add(member);
  }
  for (const calls of allowedParameterMemberCalls.values()) {
    for (const key of calls) {
      const path = key.split("|")[1];
      const member = path?.replace(/\(\)$/u, "").split(".").at(-1);
      if (member) protectedCallableMembers.add(member);
    }
  }
  const unwrapExpression = (expression) => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const derivesFromProtectedRuntime = (expression, protectedValues) => {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      return (
        protectedRuntimeBindings.has(value.text) ||
        protectedValues.has(value.text)
      );
    }
    if (
      ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)
    ) {
      const receiver = unwrapExpression(value.expression);
      if (
        ts.isIdentifier(receiver) &&
        protectedRuntimeBindings.has(receiver.text)
      ) {
        return mutationHelpers.has(staticMemberPath(value));
      }
      return derivesFromProtectedRuntime(receiver, protectedValues);
    }
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.some((element) =>
        derivesFromProtectedRuntime(element, protectedValues),
      );
    }
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) {
          return derivesFromProtectedRuntime(
            property.initializer,
            protectedValues,
          );
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return (
            protectedRuntimeBindings.has(property.name.text) ||
            protectedValues.has(property.name.text)
          );
        }
        if (ts.isSpreadAssignment(property)) {
          return derivesFromProtectedRuntime(
            property.expression,
            protectedValues,
          );
        }
        return false;
      });
    }
    if (ts.isConditionalExpression(value)) {
      return (
        derivesFromProtectedRuntime(value.whenTrue, protectedValues) ||
        derivesFromProtectedRuntime(value.whenFalse, protectedValues)
      );
    }
    if (ts.isBinaryExpression(value)) {
      return (
        derivesFromProtectedRuntime(value.left, protectedValues) ||
        derivesFromProtectedRuntime(value.right, protectedValues)
      );
    }
    if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
      return (
        (ts.isIdentifier(value.expression) &&
          protectedValues.has(value.expression.text)) ||
        (value.arguments?.some((argument) =>
          derivesFromProtectedRuntime(argument, protectedValues),
        ) ??
          false)
      );
    }
    if (
      ts.isPrefixUnaryExpression(value) ||
      ts.isPostfixUnaryExpression(value) ||
      ts.isAwaitExpression(value) ||
      ts.isYieldExpression(value) ||
      ts.isSpreadElement(value)
    ) {
      return Boolean(
        value.expression &&
          derivesFromProtectedRuntime(value.expression, protectedValues),
      );
    }
    if (ts.isTemplateExpression(value)) {
      return value.templateSpans.some((span) =>
        derivesFromProtectedRuntime(span.expression, protectedValues),
      );
    }
    return false;
  };
  const referencesNames = (node, names) => {
    let found = false;
    const scan = (current) => {
      if (found) return;
      if (ts.isIdentifier(current) && names.has(current.text)) {
        found = true;
        return;
      }
      ts.forEachChild(current, scan);
    };
    scan(node);
    return found;
  };
  const taintedFunctionNames = new Set();
  const derivesFromParameters = (expression, parameters) => {
    const unwrapped = unwrapExpression(expression);
    if (parameters.has(rootIdentifier(unwrapped))) return true;
    if (
      (ts.isArrowFunction(unwrapped) ||
        ts.isFunctionExpression(unwrapped) ||
        ts.isFunctionDeclaration(unwrapped)) &&
      unwrapped.body
    ) {
      return referencesNames(unwrapped.body, parameters);
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return (
        derivesFromParameters(unwrapped.left, parameters) ||
        derivesFromParameters(unwrapped.right, parameters)
      );
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return (
        derivesFromParameters(unwrapped.whenTrue, parameters) ||
        derivesFromParameters(unwrapped.whenFalse, parameters)
      );
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return unwrapped.elements.some((element) =>
        derivesFromParameters(element, parameters),
      );
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return unwrapped.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) {
          return derivesFromParameters(property.initializer, parameters);
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return parameters.has(property.name.text);
        }
        if (ts.isSpreadAssignment(property)) {
          return derivesFromParameters(property.expression, parameters);
        }
        return false;
      });
    }
    if (ts.isCallExpression(unwrapped) || ts.isNewExpression(unwrapped)) {
      return (
        derivesFromParameters(unwrapped.expression, parameters) ||
        (ts.isIdentifier(unwrapped.expression) &&
          taintedFunctionNames.has(unwrapped.expression.text)) ||
        (unwrapped.arguments?.some((argument) =>
          derivesFromParameters(argument, parameters),
        ) ??
          false)
      );
    }
    if (
      ts.isPrefixUnaryExpression(unwrapped) ||
      ts.isPostfixUnaryExpression(unwrapped) ||
      ts.isAwaitExpression(unwrapped) ||
      ts.isYieldExpression(unwrapped) ||
      ts.isSpreadElement(unwrapped)
    ) {
      return (
        unwrapped.expression !== undefined &&
        derivesFromParameters(unwrapped.expression, parameters)
      );
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return unwrapped.templateSpans.some((span) =>
        derivesFromParameters(span.expression, parameters),
      );
    }
    return false;
  };
  const collectAssignedNames = (target, names) => {
    const value = unwrapExpression(target);
    if (ts.isIdentifier(value)) {
      names.add(value.text);
      return;
    }
    if (
      ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)
    ) {
      const root = rootIdentifier(value);
      if (root) names.add(root);
      return;
    }
    if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        if (!ts.isOmittedExpression(element)) {
          collectAssignedNames(element, names);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          names.add(property.name.text);
        } else if (ts.isPropertyAssignment(property)) {
          collectAssignedNames(property.initializer, names);
        } else if (ts.isSpreadAssignment(property)) {
          collectAssignedNames(property.expression, names);
        }
      }
    }
  };
  const isAssignmentOperator = (kind) =>
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment;
  const isWriteTarget = (node) => {
    let current = node;
    let parent = current.parent;
    while (parent) {
      if (
        ts.isBinaryExpression(parent) &&
        isAssignmentOperator(parent.operatorToken.kind)
      ) {
        return parent.left === current;
      }
      if (
        (ts.isPrefixUnaryExpression(parent) ||
          ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        return true;
      }
      if (ts.isDeleteExpression(parent)) return true;
      if (
        (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        parent.initializer === current
      ) {
        return true;
      }
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isSpreadElement(parent)
      ) {
        current = parent;
        parent = current.parent;
        continue;
      }
      return false;
    }
    return false;
  };
  const namedFunctionContext = (node, inherited) => {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name
    ) {
      return node.name.getText(sourceFile);
    }
    return inherited;
  };
  const collectBindingOrigins = (name, sourceOrigins, origins, suffix = "") => {
    if (ts.isIdentifier(name)) {
      origins.set(
        name.text,
        new Set([...sourceOrigins].map((origin) => `${origin}${suffix}`)),
      );
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingOrigins(element.name, sourceOrigins, origins, suffix);
      }
    }
  };
  const collectAssignedOrigins = (
    target,
    sourceOrigins,
    origins,
    suffix = "",
  ) => {
    const value = unwrapExpression(target);
    if (ts.isIdentifier(value)) {
      const assigned = new Set(
        [...sourceOrigins].map((origin) => `${origin}${suffix}`),
      );
      origins.set(
        value.text,
        new Set([...(origins.get(value.text) ?? []), ...assigned]),
      );
      return;
    }
    if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        if (!ts.isOmittedExpression(element)) {
          collectAssignedOrigins(
            element,
            sourceOrigins,
            origins,
            `${suffix}[]`,
          );
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          collectAssignedOrigins(property.name, sourceOrigins, origins, suffix);
        } else if (ts.isPropertyAssignment(property)) {
          const member =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? `.${property.name.text}`
              : "";
          collectAssignedOrigins(
            property.initializer,
            sourceOrigins,
            origins,
            `${suffix}${member}`,
          );
        } else if (ts.isSpreadAssignment(property)) {
          collectAssignedOrigins(
            property.expression,
            sourceOrigins,
            origins,
            suffix,
          );
        }
      }
    }
  };
  const exactReplayPolicy = (initializer) => {
    const value = unwrapExpression(initializer);
    if (
      !ts.isObjectLiteralExpression(value) ||
      value.properties.length !== 10
    ) {
      return false;
    }
    const bigintFields = new Set([
      "initialCashMicros",
      "maxOrderMicros",
      "maxSymbolExposureMicros",
      "maxGrossExposureMicros",
      "minCashReserveMicros",
      "maxDailyLossMicros",
      "feeBps",
      "slippageBps",
    ]);
    const plainFields = new Set(["maxQuoteAgeMs", "symbolAllowlist"]);
    const seen = new Set();
    for (const property of value.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      ) {
        return false;
      }
      const name = property.name.text;
      if (seen.has(name)) return false;
      seen.add(name);
      const expectedPath = `policy.${name}`;
      const expression = unwrapExpression(property.initializer);
      if (bigintFields.has(name)) {
        if (
          !ts.isCallExpression(expression) ||
          staticMemberPath(expression.expression) !== "BigInt" ||
          expression.arguments.length !== 1 ||
          staticMemberPath(unwrapExpression(expression.arguments[0])) !==
            expectedPath
        ) {
          return false;
        }
      } else if (
        !plainFields.has(name) ||
        staticMemberPath(expression) !== expectedPath
      ) {
        return false;
      }
    }
    return [...bigintFields, ...plainFields].every((field) => seen.has(field));
  };
  const originForExpression = (expression, origins, parameters) => {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      return (
        origins.get(value.text) ??
        (parameters.has(value.text) ? new Set([value.text]) : new Set())
      );
    }
    if (
      ts.isPropertyAccessExpression(value) ||
      (ts.isElementAccessExpression(value) &&
        (ts.isStringLiteral(value.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(value.argumentExpression)))
    ) {
      const member = ts.isPropertyAccessExpression(value)
        ? value.name.text
        : value.argumentExpression.text;
      return new Set(
        [...originForExpression(value.expression, origins, parameters)].map(
          (origin) => `${origin}.${member}`,
        ),
      );
    }
    if (ts.isNewExpression(value)) {
      return staticMemberPath(value.expression) === "PaperTradingEngine"
        ? new Set(["@PaperTradingEngine"])
        : derivesFromParameters(value, parameters)
          ? new Set(["@derived"])
          : new Set();
    }
    if (ts.isCallExpression(value)) {
      const calleePath = staticMemberPath(value.expression);
      if (calleePath === "PaperTradingEngine.fromState") {
        return new Set(["@PaperTradingEngine"]);
      }
      if (calleePath === "Object.keys" || calleePath === "Object.values") {
        return new Set(["@LocalArray"]);
      }
      if (
        ts.isPropertyAccessExpression(value.expression) ||
        ts.isElementAccessExpression(value.expression)
      ) {
        const receiver = value.expression.expression;
        const member = ts.isPropertyAccessExpression(value.expression)
          ? value.expression.name.text
          : staticMemberPath(value.expression)?.split(".").at(-1);
        if (member) {
          return new Set(
            [...originForExpression(receiver, origins, parameters)].map(
              (origin) => `${origin}.${member}()`,
            ),
          );
        }
      }
      return derivesFromParameters(value, parameters)
        ? new Set(["@derived"])
        : new Set();
    }
    if (ts.isArrayLiteralExpression(value)) return new Set(["@LocalArray"]);
    if (ts.isConditionalExpression(value)) {
      return new Set([
        ...originForExpression(value.whenTrue, origins, parameters),
        ...originForExpression(value.whenFalse, origins, parameters),
      ]);
    }
    return derivesFromParameters(value, parameters)
      ? new Set(["@derived"])
      : new Set();
  };
  const isInlineSyncCallback = (callback) =>
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    !callback.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) &&
    !callback.asteriskToken;
  const isTrustedHashCall = (node) => {
    const callee = node.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "digest"
    ) {
      return false;
    }
    const update = unwrapExpression(callee.expression);
    if (
      !ts.isCallExpression(update) ||
      !ts.isPropertyAccessExpression(update.expression) ||
      update.expression.name.text !== "update"
    ) {
      return false;
    }
    const factory = unwrapExpression(update.expression.expression);
    return (
      ts.isCallExpression(factory) &&
      ts.isIdentifier(factory.expression) &&
      factory.expression.text === "createHash" &&
      factory.arguments.length === 1 &&
      ts.isStringLiteral(factory.arguments[0]) &&
      factory.arguments[0].text === "sha256" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "hex"
    );
  };
  const isTrustedHashUpdate = (node) => {
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "update" ||
      node.arguments.length !== 1
    ) {
      return false;
    }
    const factory = unwrapExpression(node.expression.expression);
    return (
      ts.isCallExpression(factory) &&
      ts.isIdentifier(factory.expression) &&
      factory.expression.text === "createHash" &&
      factory.arguments.length === 1 &&
      ts.isStringLiteral(factory.arguments[0]) &&
      factory.arguments[0].text === "sha256"
    );
  };
  const isTrustedLocalArrayCall = (node, origins, parameters) => {
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    const member = node.expression.name.text;
    if (!["every", "map", "some", "sort"].includes(member)) return false;
    const receiverOrigins = originForExpression(
      node.expression.expression,
      origins,
      parameters,
    );
    if (!receiverOrigins.has("@LocalArray")) return false;
    if (member === "sort") return node.arguments.length === 0;
    return (
      node.arguments.length === 1 && isInlineSyncCallback(node.arguments[0])
    );
  };
  const isAllowedParameterMemberCall = (
    node,
    functionContext,
    directParameters,
    origins,
    parameters,
  ) => {
    if (
      isTrustedHashCall(node) ||
      isTrustedLocalArrayCall(node, origins, parameters)
    ) {
      return true;
    }
    const path = staticMemberPath(node.expression);
    const key = path
      ? `${functionContext}|${path}|${node.arguments.length}`
      : null;
    if (!key || !allowedParameterMemberCalls.get(modulePath)?.has(key)) {
      return false;
    }
    const root = path.split(".")[0];
    if (
      !directParameters.has(root) &&
      root !== "this" &&
      !protectedRuntimeBindings.has(root)
    ) {
      const expected = allowedReceiverOrigins
        .get(modulePath)
        ?.get(`${functionContext}|${root}`);
      const actual = origins.get(root) ?? new Set();
      if (
        !expected ||
        actual.size === 0 ||
        ![...actual].every((origin) => expected.has(origin))
      ) {
        return false;
      }
    }
    const member = path.replace(/\(\)$/u, "").split(".").at(-1);
    if (member === "map" || member === "some" || member === "every") {
      const callback = node.arguments[0];
      return isInlineSyncCallback(callback);
    }
    return true;
  };
  const isReviewedParameterArgumentCall = (
    node,
    functionContext,
    directParameters,
    origins,
    parameters,
    localBindings,
  ) => {
    if (
      isAllowedParameterMemberCall(
        node,
        functionContext,
        directParameters,
        origins,
        parameters,
      ) ||
      isTrustedLocalArrayCall(node, origins, parameters) ||
      isTrustedHashUpdate(node)
    ) {
      return true;
    }
    const path = staticMemberPath(node.expression);
    if (path && reviewedPureParameterArgumentCalls.has(path)) return true;
    if (path && node.arguments.length === 1) {
      const argumentPath = staticMemberPath(node.arguments[0]);
      if (
        argumentPath &&
        allowedParameterArgumentCalls
          .get(modulePath)
          ?.has(`${functionContext}|${path}|${argumentPath}`)
      ) {
        return true;
      }
    }
    const staticReceiverKind = path
      ? reviewedStaticReceiverCalls.get(path)
      : undefined;
    if (staticReceiverKind) {
      const root = path.split(".")[0];
      if (localBindings.has(root)) return false;
      const declarations = [];
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === root
          ) {
            declarations.push(declaration);
          }
        }
      }
      if (declarations.length !== 1) return false;
      const initializer = declarations[0].initializer
        ? unwrapExpression(declarations[0].initializer)
        : undefined;
      if (staticReceiverKind === "regexp") {
        return Boolean(
          initializer && ts.isRegularExpressionLiteral(initializer),
        );
      }
      if (
        !initializer ||
        !ts.isNewExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== "Set" ||
        initializer.arguments?.length !== 1
      ) {
        return false;
      }
      const values = unwrapExpression(initializer.arguments[0]);
      return (
        ts.isArrayLiteralExpression(values) &&
        values.elements.every(
          (element) =>
            ts.isStringLiteral(element) ||
            ts.isNoSubstitutionTemplateLiteral(element),
        )
      );
    }
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "test" &&
      ts.isRegularExpressionLiteral(
        unwrapExpression(node.expression.expression),
      ) &&
      node.arguments.length === 1
    );
  };
  const sourceLocation = (node, functionContext) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return `${modulePath}:${position.line + 1}:${position.character + 1} (${functionContext})`;
  };
  const isNamedFunctionScope = (node) =>
    ts.isConstructorDeclaration(node) ||
    ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined);
  const bindingNames = (name) => {
    const names = new Set();
    collectBindingNames(name, names);
    return names;
  };
  const recordsProtectedBinding = (node) => {
    let names = new Set();
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      names = bindingNames(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    } else {
      return null;
    }
    for (const name of names) {
      if (!protectedRuntimeBindings.has(name)) continue;
      const canonicalEngineClass =
        name === "PaperTradingEngine" &&
        modulePath === `${PAPER_PACKAGE_DIR}/src/engine.ts` &&
        ts.isClassDeclaration(node) &&
        node.parent === sourceFile;
      if (!canonicalEngineClass) return name;
    }
    return null;
  };
  const visit = (
    node,
    inheritedParameters = new Set(),
    forbidAdapterReference = false,
    inheritedFunctionContext = "<module>",
    inheritedDirectParameters = new Set(),
    inheritedOrigins = new Map(),
    inheritedProtectedValues = new Set(),
    inheritedLocalBindings = new Set(),
  ) => {
    if (
      (ts.isImportDeclaration(node) && !hasRuntimeImport(node.importClause)) ||
      (ts.isExportDeclaration(node) && !hasRuntimeExport(node)) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isTypeNode(node)
    ) {
      return;
    }
    let parameters = inheritedParameters;
    let directParameters = inheritedDirectParameters;
    let origins = inheritedOrigins;
    let protectedValues = inheritedProtectedValues;
    let localBindings = inheritedLocalBindings;
    let functionContext = inheritedFunctionContext;
    if (ts.isFunctionLike(node)) {
      parameters = new Set(inheritedParameters);
      directParameters = new Set();
      origins = new Map(inheritedOrigins);
      protectedValues = new Set(inheritedProtectedValues);
      localBindings = new Set();
      functionContext = namedFunctionContext(node, inheritedFunctionContext);
      for (const parameter of node.parameters) {
        collectBindingNames(parameter.name, parameters);
        collectBindingNames(parameter.name, directParameters);
        collectBindingNames(parameter.name, localBindings);
        for (const name of bindingNames(parameter.name)) {
          origins.set(name, new Set([name]));
        }
      }
      if (node.body) {
        const collectLocalBindings = (current) => {
          if (current !== node.body && ts.isFunctionLike(current)) return;
          if (ts.isVariableDeclaration(current)) {
            collectBindingNames(current.name, localBindings);
          } else if (
            (ts.isFunctionDeclaration(current) ||
              ts.isClassDeclaration(current)) &&
            current.name
          ) {
            localBindings.add(current.name.text);
          }
          ts.forEachChild(current, collectLocalBindings);
        };
        collectLocalBindings(node.body);
      }
      if (isNamedFunctionScope(node)) {
        const expected = expectedNamedFunctionParameters
          .get(modulePath)
          ?.get(functionContext);
        if (
          expected &&
          expected.join("\0") !== [...directParameters].join("\0")
        ) {
          findings.add(
            `Reviewed function signature changed at ${sourceLocation(node, functionContext)}.`,
          );
        }
      } else if (
        node.parent &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        (ts.isPropertyAccessExpression(node.parent.expression) ||
          ts.isElementAccessExpression(node.parent.expression))
      ) {
        const callbackReceiver = node.parent.expression.expression;
        const callbackOrigins = originForExpression(
          callbackReceiver,
          inheritedOrigins,
          inheritedParameters,
        );
        const firstParameter = node.parameters[0];
        if (firstParameter) {
          collectBindingOrigins(
            firstParameter.name,
            callbackOrigins,
            origins,
            "[]",
          );
        }
      }
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
        node.name &&
        node.body &&
        referencesNames(node.body, inheritedParameters)
      ) {
        taintedFunctionNames.add(node.name.text);
      }
      if (node.body) {
        const collectTaintedNestedFunctions = (current) => {
          if (
            current !== node &&
            ts.isFunctionDeclaration(current) &&
            current.name &&
            current.body &&
            referencesNames(current.body, parameters)
          ) {
            taintedFunctionNames.add(current.name.text);
          }
          ts.forEachChild(current, collectTaintedNestedFunctions);
        };
        collectTaintedNestedFunctions(node.body);
      }
    }
    const protectedBinding = recordsProtectedBinding(node);
    if (protectedBinding) {
      findings.add(
        `Protected runtime binding "${protectedBinding}" may not be shadowed at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (ts.isModuleDeclaration(node)) {
      findings.add(
        `Runtime namespace declarations are forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (ts.isDecorator(node)) {
      findings.add(
        `Decorator execution is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      findings.add(
        `Implicit await/yield invocation is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Using) !== 0
    ) {
      findings.add(
        `Explicit resource-management hooks are forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    const isParameterDerivedContainer = (expression) => {
      const value = unwrapExpression(expression);
      return (
        (ts.isObjectLiteralExpression(value) ||
          ts.isArrayLiteralExpression(value) ||
          ts.isArrowFunction(value) ||
          ts.isFunctionExpression(value) ||
          ts.isClassExpression(value)) &&
        derivesFromParameters(value, parameters)
      );
    };
    if (
      (ts.isBinaryExpression(node) &&
        (isParameterDerivedContainer(node.left) ||
          isParameterDerivedContainer(node.right))) ||
      (ts.isTemplateExpression(node) &&
        node.templateSpans.some((span) =>
          isParameterDerivedContainer(span.expression),
        ))
    ) {
      findings.add(
        `Implicit coercion of a parameter-derived container is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.initializer &&
      derivesFromProtectedRuntime(node.initializer, protectedValues)
    ) {
      for (const name of bindingNames(node.name)) protectedValues.add(name);
      findings.add(
        `Protected runtime binding may not be captured at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      ts.isBindingElement(node) &&
      ((node.propertyName &&
        node.propertyName.getText(sourceFile) === "constructor") ||
        node.name.getText(sourceFile) === "constructor")
    ) {
      findings.add(
        `Reflective constructor binding is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      forbidAdapterReference &&
      ts.isIdentifier(node) &&
      node.text === NO_OP_ADAPTER
    ) {
      findings.add(
        `${NO_OP_ADAPTER} may not be referenced from ${modulePath}.`,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      derivesFromParameters(node.initializer, parameters)
    ) {
      collectBindingNames(node.name, parameters);
      const derivedOrigins =
        ts.isIdentifier(node.name) &&
        node.name.text === "replayPolicy" &&
        functionContext === "recomputePlanHash" &&
        exactReplayPolicy(node.initializer)
          ? new Set(["@NormalizedPaperPolicy"])
          : originForExpression(node.initializer, origins, parameters);
      collectBindingOrigins(node.name, derivedOrigins, origins);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const derivedOrigins = originForExpression(
        node.initializer,
        origins,
        parameters,
      );
      if (derivedOrigins.size > 0) {
        collectBindingOrigins(node.name, derivedOrigins, origins);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      derivesFromParameters(node.right, parameters)
    ) {
      collectAssignedNames(node.left, parameters);
      const assignedOrigins = originForExpression(
        node.right,
        origins,
        parameters,
      );
      collectAssignedOrigins(node.left, assignedOrigins, origins);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      derivesFromParameters(node.expression, parameters)
    ) {
      const iterablePath = ts.isCallExpression(node.expression)
        ? (() => {
            const callee = staticMemberPath(node.expression.expression);
            const argumentsPath = node.expression.arguments
              .map((argument) => staticMemberPath(argument))
              .join(",");
            return callee && argumentsPath
              ? `${callee}(${argumentsPath})`
              : staticMemberPath(node.expression);
          })()
        : staticMemberPath(node.expression);
      const allowedIterable =
        ts.isForOfStatement(node) &&
        iterablePath &&
        allowedParameterIterables
          .get(modulePath)
          ?.has(`${functionContext}|${iterablePath}`);
      if (!allowedIterable) {
        findings.add(
          `Non-allowlisted parameter-derived iteration is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          collectBindingNames(declaration.name, parameters);
          collectBindingOrigins(
            declaration.name,
            originForExpression(node.expression, origins, parameters),
            origins,
            "[]",
          );
        }
      } else {
        collectAssignedNames(node.initializer, parameters);
        if (ts.isIdentifier(node.initializer)) {
          collectBindingOrigins(
            node.initializer,
            originForExpression(node.expression, origins, parameters),
            origins,
            "[]",
          );
        }
      }
    }
    if (
      ts.isSpreadElement(node) &&
      derivesFromParameters(node.expression, parameters)
    ) {
      const spreadPath = ts.isCallExpression(node.expression)
        ? (() => {
            const callee = staticMemberPath(node.expression.expression);
            return callee ? `${callee}()` : null;
          })()
        : staticMemberPath(node.expression);
      if (
        !spreadPath ||
        !allowedParameterSpreads
          .get(modulePath)
          ?.has(`${functionContext}|${spreadPath}`)
      ) {
        findings.add(
          `Non-allowlisted parameter-derived iterable spread is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      findings.add(`Dynamic import is forbidden in ${modulePath}.`);
    }
    if (
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      findings.add(
        `Dynamic runtime accessor or tagged invocation is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      ts.isDeleteExpression(node) ||
      ((ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      findings.add(
        `Non-allowlisted runtime mutation is forbidden at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (ts.isNewExpression(node)) {
      const constructorPath = staticMemberPath(node.expression);
      const hasParameterArgument =
        node.arguments?.some((argument) =>
          derivesFromParameters(argument, parameters),
        ) ?? false;
      const errorMessage = node.arguments?.[0]
        ? unwrapExpression(node.arguments[0])
        : undefined;
      const reviewedErrorMessage =
        constructorPath === "Error" &&
        functionContext === "fromState" &&
        errorMessage &&
        ts.isTemplateExpression(errorMessage) &&
        errorMessage.templateSpans.length === 1 &&
        ts.isIdentifier(errorMessage.templateSpans[0].expression) &&
        errorMessage.templateSpans[0].expression.text === "field";
      const parameterConstructionAllowed =
        reviewedErrorMessage ||
        (constructorPath &&
          allowedParameterConstructors
            .get(modulePath)
            ?.has(
              `${functionContext}|${constructorPath}|${node.arguments?.length ?? 0}`,
            ));
      if (
        !constructorPath ||
        !allowedConstructors.has(constructorPath) ||
        derivesFromParameters(node.expression, parameters) ||
        (hasParameterArgument && !parameterConstructionAllowed)
      ) {
        findings.add(
          `Non-allowlisted runtime construction is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
    }
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_EXECUTION_CAPABILITIES.has(node.text) &&
      (!isNonRuntimeName(node) || LIVE_EXECUTION_MARKERS.includes(node.text)) &&
      !seenCapabilities.has(node.text)
    ) {
      seenCapabilities.add(node.text);
      findings.add(
        LIVE_EXECUTION_MARKERS.includes(node.text)
          ? `Possible live-execution call site "${node.text}" found in the paper-trading surface.`
          : `Forbidden execution capability "${node.text}" found in ${modulePath}.`,
      );
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isWriteTarget(node)
    ) {
      const writePath = staticMemberPath(node);
      const writeRoot = writePath?.split(".")[0];
      const writeOrigins = writeRoot
        ? (origins.get(writeRoot) ?? new Set())
        : new Set();
      const allowedTrustedWrite =
        writePath &&
        allowedTrustedReceiverWrites
          .get(modulePath)
          ?.has(`${functionContext}|${writePath}`);
      if (
        !allowedTrustedWrite &&
        (derivesFromParameters(node.expression, parameters) ||
          derivesFromProtectedRuntime(node.expression, protectedValues) ||
          [...writeOrigins].some((origin) =>
            origin.startsWith("@PaperTradingEngine"),
          ))
      ) {
        findings.add(
          `Non-allowlisted runtime write is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const capability = staticStringValue(node.argumentExpression);
      const computedRead = `${functionContext}|${staticMemberPath(node.expression)}|${node.argumentExpression.getText(sourceFile)}`;
      if (
        capability === null &&
        (isWriteTarget(node) ||
          !allowedComputedReads.get(modulePath)?.has(computedRead))
      ) {
        findings.add(
          `Non-allowlisted computed runtime access is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        capability &&
        FORBIDDEN_EXECUTION_CAPABILITIES.has(capability) &&
        !seenCapabilities.has(capability)
      ) {
        seenCapabilities.add(capability);
        findings.add(
          `Forbidden execution capability "${capability}" found in ${modulePath}.`,
        );
      }
    }
    if (
      ((ts.isPropertyAccessExpression(node) &&
        node.name.text === "constructor") ||
        (ts.isElementAccessExpression(node) &&
          staticStringValue(node.argumentExpression) === "constructor")) &&
      !seenCapabilities.has("constructor")
    ) {
      seenCapabilities.add("constructor");
      findings.add(
        `Reflective constructor access is forbidden in ${modulePath}.`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleePath = staticMemberPath(callee);
      const calleeMember = calleePath?.split(".").at(-1);
      if (
        ts.isIdentifier(callee) &&
        ["String", "Number", "BigInt"].includes(callee.text) &&
        node.arguments.some((argument) =>
          derivesFromParameters(argument, parameters),
        )
      ) {
        const argumentPath =
          node.arguments.length === 1
            ? staticMemberPath(node.arguments[0])
            : null;
        const allowedCoercion =
          argumentPath &&
          allowedParameterCoercions
            .get(modulePath)
            ?.has(`${functionContext}|${callee.text}|${argumentPath}`);
        if (!allowedCoercion) {
          findings.add(
            `Non-allowlisted parameter-derived coercion is forbidden at ${sourceLocation(node, functionContext)}.`,
          );
        }
      }
      if (
        (calleePath && mutationHelpers.has(calleePath)) ||
        (calleeMember && forbiddenMutationMembers.has(calleeMember))
      ) {
        findings.add(
          `Runtime reflection or mutation is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        calleePath &&
        ["call", "apply", "bind"].includes(calleePath.split(".").at(-1)) &&
        calleePath !== "Object.prototype.hasOwnProperty.call"
      ) {
        findings.add(
          `Indirect runtime invocation is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        ts.isCallExpression(unwrapExpression(callee)) ||
        ts.isArrowFunction(unwrapExpression(callee)) ||
        ts.isFunctionExpression(unwrapExpression(callee))
      ) {
        findings.add(
          `Indirect runtime invocation is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (ts.isElementAccessExpression(callee)) {
        findings.add(
          `Computed runtime invocation is forbidden in ${modulePath}.`,
        );
      }
      if (ts.isIdentifier(callee) && parameters.has(callee.text)) {
        findings.add(
          `Calling injected runtime parameter "${callee.text}" is forbidden in ${modulePath}.`,
        );
      } else if (
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        derivesFromParameters(callee.expression, parameters) &&
        !isAllowedParameterMemberCall(
          node,
          functionContext,
          directParameters,
          origins,
          parameters,
        )
      ) {
        findings.add(
          `Calling injected runtime capability through a parameter is forbidden in ${modulePath}.`,
        );
        findings.add(
          `Rejected parameter-derived call at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        node.arguments.some((argument) =>
          derivesFromParameters(argument, parameters),
        ) &&
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        calleeMember &&
        statefulMembers.has(calleeMember) &&
        !isAllowedParameterMemberCall(
          node,
          functionContext,
          directParameters,
          origins,
          parameters,
        )
      ) {
        findings.add(
          `Parameter-derived value may not escape through mutable storage at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        node.arguments.some((argument) =>
          derivesFromParameters(argument, parameters),
        ) &&
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        !isReviewedParameterArgumentCall(
          node,
          functionContext,
          directParameters,
          origins,
          parameters,
          localBindings,
        )
      ) {
        const receiver =
          ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)
            ? rootIdentifier(callee.expression)
            : null;
        if (receiver) parameters.add(receiver);
        findings.add(
          `Parameter-derived value may not be passed to a non-reviewed receiver at ${sourceLocation(node, functionContext)}.`,
        );
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      (mutationHelpers.has(staticMemberPath(node)) ||
        forbiddenMutationMembers.has(staticMemberPath(node)?.split(".").at(-1)))
    ) {
      findings.add(
        `Runtime reflection or mutation capability may not be captured at ${sourceLocation(node, functionContext)}.`,
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      const targetPath = staticMemberPath(node.left);
      const targetRoot = targetPath?.split(".")[0];
      const targetMember = targetPath?.replace(/\(\)$/u, "").split(".").at(-1);
      const targetOrigins = targetRoot
        ? (origins.get(targetRoot) ?? new Set())
        : new Set();
      const targetsTrustedReceiver = [...targetOrigins].some((origin) =>
        origin.startsWith("@PaperTradingEngine"),
      );
      const targetReceiver =
        ts.isPropertyAccessExpression(node.left) ||
        ts.isElementAccessExpression(node.left)
          ? node.left.expression
          : null;
      const allowedTrustedWrite =
        targetPath &&
        allowedTrustedReceiverWrites
          .get(modulePath)
          ?.has(`${functionContext}|${targetPath}`);
      if (derivesFromProtectedRuntime(node.right, protectedValues)) {
        collectAssignedNames(node.left, protectedValues);
        findings.add(
          `Protected runtime binding may not be captured at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        targetRoot &&
        targetRoot !== "this" &&
        !localBindings.has(targetRoot) &&
        derivesFromParameters(node.right, directParameters)
      ) {
        findings.add(
          `Parameter-derived value may not escape its reviewed function at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        targetReceiver &&
        derivesFromParameters(targetReceiver, parameters) &&
        !allowedTrustedWrite
      ) {
        findings.add(
          `Mutation through a parameter-derived receiver is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (
        (targetRoot && protectedRuntimeBindings.has(targetRoot)) ||
        (targetMember && protectedCallableMembers.has(targetMember))
      ) {
        findings.add(
          `Mutation of a trusted runtime binding or callable is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
      if (targetsTrustedReceiver && !allowedTrustedWrite) {
        findings.add(
          `Non-allowlisted trusted receiver write is forbidden at ${sourceLocation(node, functionContext)}.`,
        );
      }
    }
    ts.forEachChild(node, (child) =>
      visit(
        child,
        parameters,
        forbidAdapterReference,
        functionContext,
        directParameters,
        origins,
        protectedValues,
        localBindings,
      ),
    );
  };
  visit(
    sourceFile,
    new Set(),
    modulePath !== `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}` &&
      modulePath !== `${PAPER_PACKAGE_DIR}/src/index.ts`,
    "<module>",
    new Set(),
    new Map(),
    new Set(),
    new Set(),
  );
}

function inspectNoOpAdapterContract(sourceFile, modulePath, findings) {
  const classes = sourceFile.statements.filter(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === NO_OP_ADAPTER &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
  );
  if (classes.length !== 1) {
    findings.add(
      `${NO_OP_ADAPTER} must be exported exactly once from ${modulePath}.`,
    );
    return false;
  }

  const adapter = classes[0];
  const adapterDecorators = ts.canHaveDecorators(adapter)
    ? ts.getDecorators(adapter)
    : undefined;
  let adapterReferences = 0;
  const countAdapterReferences = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === NO_OP_ADAPTER &&
      !ts.isTypeNode(node.parent)
    ) {
      adapterReferences += 1;
    }
    ts.forEachChild(node, countAdapterReferences);
  };
  countAdapterReferences(sourceFile);
  if (adapterReferences !== 1) {
    findings.add(
      `${NO_OP_ADAPTER} may not be referenced outside its class declaration in ${modulePath}.`,
    );
    return false;
  }
  const evaluateMethods = adapter.members.filter(
    (member) =>
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "evaluate",
  );
  if (
    adapter.heritageClauses?.length ||
    adapter.members.length !== 1 ||
    evaluateMethods.length !== 1
  ) {
    findings.add(
      `${NO_OP_ADAPTER} must be a final single-method adapter with only evaluate().`,
    );
    return false;
  }

  const evaluate = evaluateMethods[0];
  const evaluateDecorators = ts.canHaveDecorators(evaluate)
    ? ts.getDecorators(evaluate)
    : undefined;
  const forbiddenModifiers = new Set([
    ts.SyntaxKind.AsyncKeyword,
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.StaticKeyword,
  ]);
  if (
    !evaluate.body ||
    adapterDecorators?.length ||
    evaluateDecorators?.length ||
    evaluate.asteriskToken ||
    evaluate.parameters.length !== 3 ||
    evaluate.parameters.some(
      (parameter) =>
        !ts.isIdentifier(parameter.name) ||
        parameter.dotDotDotToken ||
        parameter.initializer,
    ) ||
    evaluate.parameters.map((parameter) => parameter.name.text).join(",") !==
      "plan,intent,nowMs" ||
    evaluate.modifiers?.some((modifier) =>
      forbiddenModifiers.has(modifier.kind),
    )
  ) {
    findings.add(
      `${NO_OP_ADAPTER}.evaluate() must be a synchronous public instance method.`,
    );
    return false;
  }

  const allowedCalls = new Set([
    "isRecord",
    "recomputePlanHash",
    "validatePaperApprovalIntent",
  ]);
  const localFunctions = new Set(
    sourceFile.statements
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.name !== undefined &&
          statement.body !== undefined,
      )
      .map((statement) => statement.name.text),
  );
  const inspectAdapterCalls = (node) => {
    if (node !== evaluate && ts.isFunctionLike(node)) return;
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      allowedCalls.has(node.name.text)
    ) {
      findings.add(
        `${NO_OP_ADAPTER}.evaluate() may not shadow an allowlisted helper.`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const allowed =
        (ts.isIdentifier(callee) &&
          allowedCalls.has(callee.text) &&
          localFunctions.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ((ts.isIdentifier(callee.expression) &&
            callee.expression.text === "SHA256" &&
            callee.name.text === "test") ||
            (ts.isStringLiteral(callee.expression) &&
              callee.name.text === "repeat")));
      if (!allowed) {
        findings.add(
          `${NO_OP_ADAPTER}.evaluate() contains a non-allowlisted call expression.`,
        );
      }
    } else if (
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      findings.add(
        `${NO_OP_ADAPTER}.evaluate() contains a non-allowlisted executable expression.`,
      );
    }
    ts.forEachChild(node, inspectAdapterCalls);
  };
  inspectAdapterCalls(evaluate.body);

  const returns = [];
  const collectReturns = (node) => {
    if (node !== evaluate && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collectReturns);
  };
  collectReturns(evaluate.body);
  const blockTerminates = (block) => {
    const finalStatement = block.statements.at(-1);
    if (!finalStatement) return false;
    if (ts.isReturnStatement(finalStatement)) return true;
    if (ts.isBlock(finalStatement)) return blockTerminates(finalStatement);
    if (ts.isIfStatement(finalStatement)) {
      return (
        finalStatement.elseStatement !== undefined &&
        statementTerminates(finalStatement.thenStatement) &&
        statementTerminates(finalStatement.elseStatement)
      );
    }
    if (ts.isTryStatement(finalStatement)) {
      return (
        blockTerminates(finalStatement.tryBlock) &&
        (finalStatement.catchClause === undefined ||
          blockTerminates(finalStatement.catchClause.block)) &&
        (finalStatement.finallyBlock === undefined ||
          blockTerminates(finalStatement.finallyBlock))
      );
    }
    return false;
  };
  const statementTerminates = (statement) =>
    ts.isReturnStatement(statement) ||
    (ts.isBlock(statement) && blockTerminates(statement)) ||
    (ts.isIfStatement(statement) &&
      statement.elseStatement !== undefined &&
      statementTerminates(statement.thenStatement) &&
      statementTerminates(statement.elseStatement));
  const everyReturnIsNoOp =
    returns.length > 0 &&
    blockTerminates(evaluate.body) &&
    returns.every((statement) => {
      if (
        !statement.expression ||
        !ts.isObjectLiteralExpression(statement.expression)
      ) {
        return false;
      }
      if (
        statement.expression.properties.some(
          (property) =>
            !ts.isPropertyAssignment(property) ||
            (!ts.isIdentifier(property.name) &&
              !ts.isStringLiteral(property.name)),
        )
      ) {
        return false;
      }
      const executedProperties = statement.expression.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) &&
            property.name.text === "executed") ||
            (ts.isStringLiteral(property.name) &&
              property.name.text === "executed")),
      );
      return (
        executedProperties.length === 1 &&
        executedProperties[0].initializer.kind === ts.SyntaxKind.FalseKeyword
      );
    });
  if (!everyReturnIsNoOp) {
    findings.add(
      `Every ${NO_OP_ADAPTER}.evaluate() return must set executed to the false literal.`,
    );
    return false;
  }
  return true;
}

function inspectExecutionModuleClosure(repoRoot, entryPath) {
  const findings = new Set();
  const sources = new Map();
  const sourceFiles = new Map();
  const pending = [entryPath];

  while (pending.length > 0) {
    const modulePath = pending.shift();
    if (sources.has(modulePath)) continue;

    let source;
    try {
      source = readFileSync(
        assertContainedRegularFile(
          repoRoot,
          modulePath,
          "paper execution runtime dependency",
        ).absolute,
        "utf8",
      );
    } catch (cause) {
      // error-policy:J1 Unreadable closure members make the public status unavailable.
      findings.add(`Could not read ${modulePath}: ${cause.message}`);
      continue;
    }
    sources.set(modulePath, source);

    const sourceFile = ts.createSourceFile(
      modulePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    sourceFiles.set(modulePath, sourceFile);
    for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
      findings.add(
        `Could not parse ${modulePath}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          " ",
        )}`,
      );
    }
    inspectModuleCapabilities(sourceFile, modulePath, findings);

    for (const statement of sourceFile.statements) {
      let specifier = null;
      if (
        ts.isImportDeclaration(statement) &&
        hasRuntimeImport(statement.importClause) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
      } else if (
        ts.isExportDeclaration(statement) &&
        hasRuntimeExport(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(statement)) {
        findings.add(`Import-equals is forbidden in ${modulePath}.`);
      }
      if (specifier === null) continue;

      if (!specifier.startsWith(".")) {
        const finding = inspectAllowedRuntimeImport(
          statement,
          specifier,
          modulePath,
        );
        if (finding) findings.add(finding);
        continue;
      }
      const relativeFinding = inspectAllowedRelativeRuntimeImport(
        statement,
        specifier,
        modulePath,
      );
      if (relativeFinding) findings.add(relativeFinding);
      try {
        pending.push(resolveExecutionImport(repoRoot, modulePath, specifier));
      } catch (cause) {
        // error-policy:J1 Unresolvable edges make the status unavailable.
        findings.add(
          `Could not resolve runtime dependency "${specifier}" from ${modulePath}: ${cause.message}.`,
        );
      }
    }
  }

  return { findings, sources, sourceFiles };
}

/**
 * Collect every local runtime module reachable from the canonical public entry.
 * This graph is digest-only: public market-data code may legitimately perform
 * read-only I/O, while the readiness-rooted closure below has a much narrower
 * capability policy. The mandatory digest must still commit to both surfaces.
 */
function collectPublicRuntimeModuleClosure(repoRoot, entryPath) {
  const findings = new Set();
  const sources = new Map();
  const pending = [entryPath];

  while (pending.length > 0) {
    const modulePath = pending.shift();
    if (sources.has(modulePath)) continue;

    let source;
    try {
      source = readFileSync(
        assertContainedRegularFile(
          repoRoot,
          modulePath,
          "paper package runtime dependency",
        ).absolute,
        "utf8",
      );
    } catch (cause) {
      // error-policy:J1 Unreadable graph members make the status unavailable.
      findings.add(`Could not read ${modulePath}: ${cause.message}`);
      continue;
    }
    sources.set(modulePath, source);

    const sourceFile = ts.createSourceFile(
      modulePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
      findings.add(
        `Could not parse ${modulePath}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          " ",
        )}`,
      );
    }

    const localSpecifiers = new Set();
    const visit = (node) => {
      let specifier = null;
      if (
        ts.isImportDeclaration(node) &&
        hasRuntimeImport(node.importClause) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isExportDeclaration(node) &&
        hasRuntimeExport(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifier = node.arguments[0].text;
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
        findings.add(
          `Import-equals cannot be included in the reviewed runtime graph in ${modulePath}.`,
        );
      }
      if (specifier?.startsWith(".")) localSpecifiers.add(specifier);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    for (const specifier of localSpecifiers) {
      try {
        pending.push(resolveExecutionImport(repoRoot, modulePath, specifier));
      } catch (cause) {
        // error-policy:J1 Unresolvable edges make the status unavailable.
        findings.add(
          `Could not resolve runtime dependency "${specifier}" from ${modulePath}: ${cause.message}.`,
        );
      }
    }
  }

  return { findings, sources };
}

/**
 * Run identity arrives as arguments rather than being read from `process.env`
 * so the record is a pure function of its inputs: the same arguments always
 * produce the same record, and the script stays testable outside CI.
 */
const IDENTITY_FLAGS = ["repository", "ref", "commit", "run-id"];

export function parseArgs(argv) {
  const lanes = [];
  const identity = {
    repository: null,
    ref: null,
    commit: null,
    "run-id": null,
  };
  let out = null;

  for (const arg of argv) {
    if (arg.startsWith("--lane=")) {
      const raw = arg.slice("--lane=".length);
      const sep = raw.lastIndexOf("=");
      if (sep < 1) {
        throw new Error(`Malformed --lane (expected name=status): ${raw}`);
      }
      const name = raw.slice(0, sep);
      const status = raw.slice(sep + 1);
      if (!["pass", "fail", "skip"].includes(status)) {
        throw new Error(`Lane ${name} has unknown status "${status}".`);
      }
      lanes.push({ name, status });
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    const flag = IDENTITY_FLAGS.find((candidate) =>
      arg.startsWith(`--${candidate}=`),
    );
    if (flag) {
      const value = arg.slice(`--${flag}=`.length);
      identity[flag] = value === "" ? null : value;
      continue;
    }
    throw new Error(`Unrecognized argument: ${arg}`);
  }

  if (!out) {
    throw new Error("Missing required --out=<path>.");
  }
  if (lanes.length === 0) {
    throw new Error("At least one --lane=<name>=<status> is required.");
  }
  return { lanes, out, identity };
}

/**
 * Confirms the paper-only invariant by reading source rather than trusting a
 * flag: a constant asserting "paper mode" is exactly what a change introducing
 * live execution would forget to update.
 */
export function inspectExecutionSurface(
  repoRoot = REPO_ROOT,
  expectedClosureSha256 = EXPECTED_EXECUTION_CLOSURE_SHA256,
) {
  const findings = new Set();
  let declaration;
  let manifestSource;
  const buildInputs = new Map();
  try {
    const manifestPath = `${PAPER_PACKAGE_DIR}/package.json`;
    manifestSource = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        manifestPath,
        "canonical paper package manifest",
      ).absolute,
      "utf8",
    );
    const manifest = JSON.parse(manifestSource);
    const buildConfigSource = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        PAPER_BUILD_CONFIG,
        "paper package build configuration",
      ).absolute,
      "utf8",
    );
    const sharedBuildConfigSource = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        SHARED_BUILD_CONFIG,
        "shared paper package build configuration",
      ).absolute,
      "utf8",
    );
    validatePaperBuildConfig(JSON.parse(buildConfigSource));
    const sharedBuildConfig = JSON.parse(sharedBuildConfigSource);
    if (
      !sharedBuildConfig ||
      typeof sharedBuildConfig !== "object" ||
      Array.isArray(sharedBuildConfig) ||
      "extends" in sharedBuildConfig
    ) {
      throw new Error(
        `${SHARED_BUILD_CONFIG} must be a terminal JSON configuration`,
      );
    }
    buildInputs.set(PAPER_BUILD_CONFIG, buildConfigSource);
    buildInputs.set(SHARED_BUILD_CONFIG, sharedBuildConfigSource);
    if (manifest.name !== PAPER_PACKAGE_NAME) {
      throw new Error(`${manifestPath} must identify ${PAPER_PACKAGE_NAME}`);
    }
    if (manifest.elizaos?.scripts?.paperStatus !== true) {
      throw new Error(
        `${manifestPath} must declare elizaos.scripts.paperStatus=true`,
      );
    }
    const sourceEntry = manifest.exports?.["."]?.["eliza-source"]?.import;
    if (sourceEntry !== CANONICAL_SOURCE_ENTRY) {
      throw new Error(
        `${manifestPath} must bind exports["."].eliza-source.import to ${CANONICAL_SOURCE_ENTRY}`,
      );
    }
    declaration = {
      package: manifest.name,
      packageDir: PAPER_PACKAGE_DIR,
      paperStatus: true,
      sourceEntry,
      index: `${PAPER_PACKAGE_DIR}/${CANONICAL_SOURCE_ENTRY.slice(2)}`,
    };
  } catch (cause) {
    return {
      adapter: "unreadable",
      liveExecution: "unknown",
      findings: [
        `Could not discover paper execution surface: ${cause.message}`,
      ],
    };
  }

  let index;
  try {
    index = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        declaration.index,
        "paper execution public source",
      ).absolute,
      "utf8",
    );
  } catch (cause) {
    return {
      adapter: "unreadable",
      liveExecution: "unknown",
      findings: [`Could not read ${declaration.index}: ${cause.message}`],
    };
  }

  const sourceFile = ts.createSourceFile(
    declaration.index,
    index,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    findings.add(
      `Could not parse ${declaration.index}: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " ",
      )}`,
    );
  }
  inspectModuleCapabilities(sourceFile, declaration.index, findings);
  inspectPublicRuntimeExports(sourceFile, declaration.index, findings);
  if (
    sourceFile.statements.some(
      (statement) => !ts.isExportDeclaration(statement),
    )
  ) {
    findings.add(
      `${declaration.index} must contain only static re-export declarations.`,
    );
  }
  const noOpReExports = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== CANONICAL_READINESS_EXPORT ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      return [];
    }
    return statement.exportClause.elements.filter(
      (element) =>
        !element.isTypeOnly &&
        element.propertyName === undefined &&
        element.name.text === NO_OP_ADAPTER,
    );
  });
  const sourceSha256 = (executionSources = new Map()) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          declaration,
          manifest: {
            path: `${PAPER_PACKAGE_DIR}/package.json`,
            source: manifestSource,
          },
          buildInputs: [...buildInputs.entries()]
            .sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([path, source]) => ({ path, source })),
          publicRuntimeClosure: [...executionSources.entries()]
            .sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([path, source]) => ({ path, source })),
        }),
      )
      .digest("hex");
  if (noOpReExports.length !== 1) {
    findings.add(
      `${NO_OP_ADAPTER} must be directly re-exported exactly once from ` +
        `${CANONICAL_READINESS_EXPORT} by canonical source ${declaration.index}.`,
    );
    return {
      adapter: "unknown",
      liveExecution: "unknown",
      sourceHash: sourceSha256().slice(0, 16),
      findings: [...findings],
    };
  }

  declaration.readiness = posix.join(
    declaration.packageDir,
    CANONICAL_READINESS_SOURCE,
  );
  try {
    const resolvedReadiness = resolveExecutionImport(
      repoRoot,
      declaration.index,
      CANONICAL_READINESS_EXPORT,
    );
    if (resolvedReadiness !== declaration.readiness) {
      findings.add(
        `${CANONICAL_READINESS_EXPORT} must resolve to ${declaration.readiness}.`,
      );
    }
  } catch (cause) {
    // error-policy:J1 Ambiguous readiness resolution makes status unavailable.
    findings.add(
      `Could not resolve ${CANONICAL_READINESS_EXPORT} from ${declaration.index}: ${cause.message}.`,
    );
  }

  const closure = inspectExecutionModuleClosure(
    repoRoot,
    declaration.readiness,
  );
  for (const finding of closure.findings) findings.add(finding);
  const publicRuntimeClosure = collectPublicRuntimeModuleClosure(
    repoRoot,
    declaration.index,
  );
  for (const finding of publicRuntimeClosure.findings) findings.add(finding);
  const readinessSourceFile = closure.sourceFiles.get(declaration.readiness);
  const hasNoOpAdapter =
    readinessSourceFile !== undefined &&
    inspectNoOpAdapterContract(
      readinessSourceFile,
      declaration.readiness,
      findings,
    );
  const executionClosureSha256 = sourceSha256(publicRuntimeClosure.sources);
  if (
    expectedClosureSha256 &&
    executionClosureSha256 !== expectedClosureSha256
  ) {
    findings.add(
      `Execution closure digest changed: expected ${expectedClosureSha256}, got ${executionClosureSha256}.`,
    );
  }

  return {
    adapter: hasNoOpAdapter ? NO_OP_ADAPTER : "unknown",
    liveExecution: findings.size === 0 ? false : "unknown",
    sourceHash: executionClosureSha256.slice(0, 16),
    sourceSha256: executionClosureSha256,
    findings: [...findings],
  };
}

export function assessPaperLanes(lanes) {
  const counts = new Map();
  for (const lane of lanes) {
    counts.set(lane.name, (counts.get(lane.name) ?? 0) + 1);
  }

  const missing = REQUIRED_PAPER_LANES.filter((name) => !counts.has(name));
  const skipped = lanes
    .filter(
      (lane) =>
        REQUIRED_PAPER_LANES.includes(lane.name) && lane.status === "skip",
    )
    .map((lane) => lane.name);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  const unexpected = [...counts.keys()]
    .filter((name) => !REQUIRED_PAPER_LANES.includes(name))
    .sort();

  return {
    required: [...REQUIRED_PAPER_LANES],
    complete:
      missing.length === 0 &&
      skipped.length === 0 &&
      duplicates.length === 0 &&
      unexpected.length === 0,
    missing,
    skipped,
    duplicates,
    unexpected,
  };
}

export function buildPaperStatusRecord({
  lanes,
  identity,
  execution,
  generatedAt = new Date().toISOString(),
}) {
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error(`Invalid generatedAt timestamp: ${generatedAt}`);
  }
  const laneIntegrity = assessPaperLanes(lanes);

  const failed = lanes.filter((lane) => lane.status === "fail");
  const overall =
    failed.length > 0 ||
    !laneIntegrity.complete ||
    execution.liveExecution !== false
      ? "red"
      : "green";

  const runId = identity["run-id"];
  const repo = identity.repository;

  return {
    schema: SCHEMA,
    generatedAt,
    validUntil: new Date(generatedAtMs + PAPER_STATUS_MAX_AGE_MS).toISOString(),
    overall,
    repository: repo,
    ref: identity.ref,
    commit: identity.commit,
    runId,
    runUrl:
      repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null,
    lanes,
    failingLanes: failed.map((lane) => lane.name),
    laneIntegrity,
    execution: {
      mode: "paper-only",
      adapter: execution.adapter,
      liveExecution: execution.liveExecution,
      sourceHash: execution.sourceHash ?? null,
      findings: execution.findings,
    },
  };
}

function main() {
  const { lanes, out, identity } = parseArgs(process.argv.slice(2));
  const record = buildPaperStatusRecord({
    lanes,
    identity,
    execution: inspectExecutionSurface(),
  });

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(resolve(process.cwd(), out), serialized, "utf8");
  process.stdout.write(serialized);

  // A red record is a successful emission. The workflow decides what a red
  // status means for the job; this script's job is to report it accurately.
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main();
}
