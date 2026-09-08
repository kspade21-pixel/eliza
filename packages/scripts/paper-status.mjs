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
  "SharedWorker",
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
      [
        "./engine.js",
        new Set(["DEFAULT_PAPER_POLICY", "PaperTradingEngine"]),
      ],
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
  const safeParameterMemberCalls = new Set([
    "at",
    "entries",
    "every",
    "includes",
    "map",
    "some",
    "sort",
    "toString",
    "trim",
  ]);
  const derivesFromParameters = (expression, parameters) => {
    if (parameters.has(rootIdentifier(expression))) return true;
    if (ts.isBinaryExpression(expression)) {
      return (
        derivesFromParameters(expression.left, parameters) ||
        derivesFromParameters(expression.right, parameters)
      );
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        derivesFromParameters(expression.whenTrue, parameters) ||
        derivesFromParameters(expression.whenFalse, parameters)
      );
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) =>
        derivesFromParameters(element, parameters),
      );
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          derivesFromParameters(property.initializer, parameters),
      );
    }
    return false;
  };
  const visit = (
    node,
    inheritedParameters = new Set(),
    forbidAdapterReference = false,
  ) => {
    if (
      (ts.isImportDeclaration(node) &&
        !hasRuntimeImport(node.importClause)) ||
      (ts.isExportDeclaration(node) && !hasRuntimeExport(node)) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isTypeNode(node)
    ) {
      return;
    }
    let parameters = inheritedParameters;
    if (ts.isFunctionLike(node)) {
      parameters = new Set(inheritedParameters);
      for (const parameter of node.parameters) {
        collectBindingNames(parameter.name, parameters);
      }
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
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      derivesFromParameters(node.right, parameters)
    ) {
      parameters.add(node.left.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      findings.add(`Dynamic import is forbidden in ${modulePath}.`);
    }
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_EXECUTION_CAPABILITIES.has(node.text) &&
      (!isNonRuntimeName(node) ||
        LIVE_EXECUTION_MARKERS.includes(node.text)) &&
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
      ((ts.isPropertyAccessExpression(node) &&
        node.name.text === "constructor") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "constructor")) &&
      !seenCapabilities.has("constructor")
    ) {
      seenCapabilities.add("constructor");
      findings.add(
        `Reflective constructor access is forbidden in ${modulePath}.`,
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
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
        parameters.has(rootIdentifier(callee))
      ) {
        const member = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isStringLiteral(callee.argumentExpression)
            ? callee.argumentExpression.text
            : null;
        if (member === null || !safeParameterMemberCalls.has(member)) {
          findings.add(
            `Calling injected runtime capability through a parameter is forbidden in ${modulePath}.`,
          );
        }
      }
    }
    ts.forEachChild(node, (child) =>
      visit(child, parameters, forbidAdapterReference),
    );
  };
  visit(
    sourceFile,
    new Set(),
    modulePath !== `${PAPER_PACKAGE_DIR}/${CANONICAL_READINESS_SOURCE}` &&
      modulePath !== `${PAPER_PACKAGE_DIR}/src/index.ts`,
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
      ((ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        allowedCalls.has(node.name.text))
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
    } else if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
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
export function inspectExecutionSurface(repoRoot = REPO_ROOT) {
  const findings = new Set();
  let declaration;
  try {
    const manifestPath = `${PAPER_PACKAGE_DIR}/package.json`;
    const manifest = JSON.parse(
      readFileSync(
        assertContainedRegularFile(
          repoRoot,
          manifestPath,
          "canonical paper package manifest",
        ).absolute,
        "utf8",
      ),
    );
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
  const sourceHash = (executionSources = new Map()) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          declaration,
          index: { path: declaration.index, source: index },
          executionClosure: [...executionSources.entries()]
            .sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([path, source]) => ({ path, source })),
        }),
      )
      .digest("hex")
      .slice(0, 16);
  if (noOpReExports.length !== 1) {
    findings.add(
      `${NO_OP_ADAPTER} must be directly re-exported exactly once from ` +
        `${CANONICAL_READINESS_EXPORT} by canonical source ${declaration.index}.`,
    );
    return {
      adapter: "unknown",
      liveExecution: "unknown",
      sourceHash: sourceHash(),
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

  const closure = inspectExecutionModuleClosure(repoRoot, declaration.readiness);
  for (const finding of closure.findings) findings.add(finding);
  const readinessSourceFile = closure.sourceFiles.get(declaration.readiness);
  const hasNoOpAdapter =
    readinessSourceFile !== undefined &&
    inspectNoOpAdapterContract(
      readinessSourceFile,
      declaration.readiness,
      findings,
    );

  return {
    adapter: hasNoOpAdapter ? NO_OP_ADAPTER : "unknown",
    liveExecution: findings.size === 0 ? false : "unknown",
    sourceHash: sourceHash(closure.sources),
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
