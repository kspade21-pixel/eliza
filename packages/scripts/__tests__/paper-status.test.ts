/**
 * Proves the machine-readable paper health feed fails closed when required
 * verification lanes or the no-op execution boundary are incomplete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assessPaperLanes,
  buildPaperStatusRecord,
  inspectExecutionSurface,
  PAPER_STATUS_MAX_AGE_MS,
  REQUIRED_PAPER_LANES,
} from "../paper-status.mjs";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dir, "../../..");
const identity = {
  repository: "kspade21-pixel/eliza",
  ref: "develop",
  commit: "a".repeat(40),
  "run-id": "123",
};
const paperOnlyExecution = {
  adapter: "NoOpExecutionAdapter",
  liveExecution: false,
  sourceHash: "b".repeat(16),
  findings: [],
};
const minimalNoOpAdapter =
  "export class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; return { executed: false }; } }\n";

function noOpAdapterWithBody(body: string): string {
  return `export class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; ${body} return { executed: false }; } }\n`;
}

function completeLanes(status: "pass" | "fail" | "skip" = "pass") {
  return REQUIRED_PAPER_LANES.map((name) => ({ name, status }));
}

function record(lanes: Array<{ name: string; status: string }>) {
  return buildPaperStatusRecord({
    lanes,
    identity,
    execution: paperOnlyExecution,
    generatedAt: "2026-08-29T00:00:00.000Z",
  });
}

async function executionFixture({
  readiness = minimalNoOpAdapter,
  index = 'export { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
  files = {},
}: {
  readiness?: string;
  index?: string;
  files?: Record<string, string>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "paper-status-"));
  tempDirs.push(root);
  const source = join(root, "plugins", "plugin-paper-trading", "src");
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ workspaces: ["plugins/*"] }, null, 2)}\n`,
    ),
    writeFile(
      join(root, "plugins", "plugin-paper-trading", "package.json"),
      `${JSON.stringify(
        {
          name: "@elizaos/plugin-paper-trading",
          exports: {
            ".": {
              "eliza-source": { import: "./src/index.ts" },
            },
          },
          elizaos: {
            scripts: {
              paperStatus: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(source, "launch-readiness.ts"), readiness),
    writeFile(join(source, "index.ts"), index),
    ...Object.entries(files).map(async ([relativePath, contents]) => {
      const target = join(source, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("paper status lane integrity", () => {
  test("reports green only for the exact complete all-pass lane set", () => {
    const result = record(completeLanes());

    expect(result.overall).toBe("green");
    expect(result.validUntil).toBe("2026-08-30T00:00:00.000Z");
    expect(PAPER_STATUS_MAX_AGE_MS).toBe(86_400_000);
    expect(result.failingLanes).toEqual([]);
    expect(result.laneIntegrity).toEqual({
      required: [...REQUIRED_PAPER_LANES],
      complete: true,
      missing: [],
      skipped: [],
      duplicates: [],
      unexpected: [],
    });
  });
  test("reports a failed required lane as red", () => {
    const lanes = completeLanes();
    lanes[2] = { ...lanes[2], status: "fail" };

    const result = record(lanes);

    expect(result.overall).toBe("red");
    expect(result.failingLanes).toEqual(["paper-typecheck"]);
  });

  test("reports skipped required evidence as red", () => {
    const lanes = completeLanes();
    lanes[3] = { ...lanes[3], status: "skip" };

    const result = record(lanes);

    expect(result.overall).toBe("red");
    expect(result.laneIntegrity.skipped).toEqual(["paper-tests"]);
    expect(result.laneIntegrity.complete).toBe(false);
  });

  test("reports missing required evidence as red", () => {
    const lanes = completeLanes().filter(({ name }) => name !== "build-core");

    const result = record(lanes);

    expect(result.overall).toBe("red");
    expect(result.laneIntegrity.missing).toEqual(["build-core"]);
  });

  test("reports duplicate evidence as red even when both entries pass", () => {
    const lanes = [...completeLanes(), { name: "paper-tests", status: "pass" }];

    const result = record(lanes);

    expect(result.overall).toBe("red");
    expect(result.laneIntegrity.duplicates).toEqual(["paper-tests"]);
  });

  test("reports unexpected lane evidence as red", () => {
    const lanes = [...completeLanes(), { name: "live-orders", status: "pass" }];

    const result = record(lanes);

    expect(result.overall).toBe("red");
    expect(result.laneIntegrity.unexpected).toEqual(["live-orders"]);
  });

  test("assesses the direct one-lane regression as incomplete", () => {
    expect(assessPaperLanes([{ name: "install", status: "pass" }])).toEqual(
      expect.objectContaining({
        complete: false,
        missing: REQUIRED_PAPER_LANES.filter((name) => name !== "install"),
      }),
    );
  });

  test("keeps the status producer and canonical PR gate wired to the contract", async () => {
    const [nightly, staticSmoke, reconcile, effectsSource] = await Promise.all([
      readFile(
        join(repoRoot, ".github", "workflows", "paper-nightly.yml"),
        "utf8",
      ),
      readFile(
        join(repoRoot, ".github", "workflows", "pr-static-smoke.yml"),
        "utf8",
      ),
      readFile(
        join(repoRoot, ".github", "workflows", "develop-reconcile.yml"),
        "utf8",
      ),
      readFile(join(repoRoot, ".github", "develop-effects.json"), "utf8"),
    ]);
    const emittedLanes = [...nightly.matchAll(/--lane=([^=\s]+)=/g)].map(
      (match) => match[1],
    );

    expect(emittedLanes).toEqual([...REQUIRED_PAPER_LANES]);
    expect(nightly).toContain("id: status_contract");
    expect(nightly).toContain("inputs.source_sha || github.sha");
    expect(nightly).toContain("inputs.effect_digest || 'manual'");
    expect(nightly).toContain('[[ "$develop_tip" == "$SOURCE_SHA" ]]');
    expect(nightly).toContain('[[ "$develop_tip" == "$record_sha" ]]');
    expect(nightly).toContain(
      "bun test packages/scripts/__tests__/paper-status.test.ts",
    );
    expect(staticSmoke).toContain(
      "bun test packages/scripts/__tests__/paper-status.test.ts",
    );
    expect(reconcile).not.toContain("paper-nightly.yml/dispatches");
    const effects = JSON.parse(effectsSource) as {
      effects: Array<{
        id: string;
        workflow: string;
        bindSourceSha?: boolean;
      }>;
    };
    expect(effects.effects).toContainEqual(
      expect.objectContaining({
        id: "paper-status",
        workflow: "paper-nightly.yml",
        bindSourceSha: true,
      }),
    );
  });
});

describe("paper status execution boundary", () => {
  test("keeps the real paper adapter green without traversing market data", () => {
    const result = inspectExecutionSurface(repoRoot);
    const repeated = inspectExecutionSurface(repoRoot);

    expect(result).toEqual(
      expect.objectContaining({
        adapter: "NoOpExecutionAdapter",
        liveExecution: false,
        findings: [],
      }),
    );
    expect(repeated).toEqual(result);
  });

  test("recognizes the explicit no-op adapter in an otherwise clean surface", async () => {
    const result = inspectExecutionSurface(await executionFixture());

    expect(result).toEqual(
      expect.objectContaining({
        adapter: "NoOpExecutionAdapter",
        liveExecution: false,
        findings: [],
      }),
    );
  });

  test("reports a live-execution marker as unknown and forces red", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        index: "export const placeOrder = () => {};\n",
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Possible live-execution call site "placeOrder" found in the paper-trading surface.',
    );
    expect(
      buildPaperStatusRecord({
        lanes: completeLanes(),
        identity,
        execution,
        generatedAt: "2026-08-29T00:00:00.000Z",
      }).overall,
    ).toBe("red");
  });

  test.each([
    [
      "direct fetch",
      noOpAdapterWithBody(
        'fetch("https://broker.invalid/orders", { method: "POST" });',
      ),
      'Forbidden execution capability "fetch" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
    [
      "aliased fetch",
      `const post = fetch;\n${noOpAdapterWithBody(
        'post("https://broker.invalid/orders", { method: "POST" });',
      )}`,
      'Forbidden execution capability "fetch" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
    [
      "global fetch lookup",
      noOpAdapterWithBody(
        'globalThis["fetch"]("https://broker.invalid/orders", { method: "POST" });',
      ),
      'Forbidden execution capability "globalThis" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
    [
      "Node global fetch lookup",
      noOpAdapterWithBody(
        'global["fetch"]("https://broker.invalid/orders", { method: "POST" });',
      ),
      'Forbidden execution capability "global" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
  ])("rejects %s in the canonical adapter", async (_name, readiness, finding) => {
    const execution = inspectExecutionSurface(
      await executionFixture({ readiness }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(finding);
    expect(
      buildPaperStatusRecord({
        lanes: completeLanes(),
        identity,
        execution,
        generatedAt: "2026-08-29T00:00:00.000Z",
      }).overall,
    ).toBe("red");
  });

  test("rejects a network call hidden in a reachable local helper", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness:
          `import { postOrder } from "./broker-helper.js";\n${noOpAdapterWithBody(
            "postOrder();",
          )}`,
        files: {
          "broker-helper.ts":
            'export function postOrder() { return fetch("https://broker.invalid/orders", { method: "POST" }); }\n',
        },
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Forbidden execution capability "fetch" found in plugins/plugin-paper-trading/src/broker-helper.ts.',
    );
  });

  test("rejects an empty side-effect import that hides a network call", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness: `import {} from "./side-effect.js";\n${minimalNoOpAdapter}`,
        files: {
          "side-effect.ts":
            'fetch("https://broker.invalid/orders", { method: "POST" });\n',
        },
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Forbidden execution capability "fetch" found in plugins/plugin-paper-trading/src/side-effect.ts.',
    );
  });

  test("rejects a forbidden external runtime dependency", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness:
          `import { request } from "node:https";\n${noOpAdapterWithBody(
            'request("https://broker.invalid/orders");',
          )}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Forbidden runtime dependency "node:https" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
  });

  test.each([
    [
      "dynamic import",
      'void import("./broker.js");',
      "Dynamic import is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    ],
    [
      "require",
      'require("node:https");',
      'Forbidden execution capability "require" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
    [
      "eval",
      'eval("void 0");',
      'Forbidden execution capability "eval" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
    [
      "Function constructor",
      'Function("return 1")();',
      'Forbidden execution capability "Function" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    ],
  ])("rejects %s capability loading", async (_name, body, finding) => {
    const execution = inspectExecutionSurface(
      await executionFixture({ readiness: noOpAdapterWithBody(body) }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(finding);
  });

  test("ignores capability names in comments, strings, and type-only imports", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness:
          'import type { fetch } from "./capability-types.js";\n// fetch("https://broker.invalid/orders")\nconst note = "fetch placeOrder";\nconst labels = { fetch: "display only" };\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; void note; void labels; return { executed: false }; } }\n',
        files: {
          "capability-types.ts": "export type fetch = string;\n",
        },
      }),
    );

    expect(execution.liveExecution).toBe(false);
    expect(execution.findings).toEqual([]);
  });

  test("fails closed on missing and out-of-tree runtime dependencies", async () => {
    const missing = inspectExecutionSurface(
      await executionFixture({
        readiness:
          `import { helper } from "./missing.js";\n${noOpAdapterWithBody(
            "helper();",
          )}`,
      }),
    );
    const escaped = inspectExecutionSurface(
      await executionFixture({
        readiness:
          `import { helper } from "../../../outside.js";\n${noOpAdapterWithBody(
            "helper();",
          )}`,
      }),
    );

    expect(missing.liveExecution).toBe("unknown");
    expect(
      missing.findings.some((finding) => finding.includes("Could not read")),
    ).toBe(true);
    expect(escaped.liveExecution).toBe("unknown");
    expect(
      escaped.findings.some((finding) =>
        finding.includes("runtime import escapes"),
      ),
    ).toBe(true);
  });

  test("fails closed on malformed adapter and helper source", async () => {
    const malformedAdapter = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate( { return { executed: false }; } }\n",
      }),
    );
    const malformedHelper = inspectExecutionSurface(
      await executionFixture({
        readiness:
          `import { helper } from "./helper.js";\n${noOpAdapterWithBody(
            "helper();",
          )}`,
        files: {
          "helper.ts": "export function helper( {\n",
        },
      }),
    );

    expect(malformedAdapter.liveExecution).toBe("unknown");
    expect(
      malformedAdapter.findings.some((finding) =>
        finding.startsWith("Could not parse"),
      ),
    ).toBe(true);
    expect(malformedHelper.liveExecution).toBe("unknown");
    expect(
      malformedHelper.findings.some((finding) =>
        finding.startsWith("Could not parse"),
      ),
    ).toBe(true);
  });

  test("walks nested and cyclic non-allowlisted dependencies once", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness:
          'import { first } from "./first.js";\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; void first; return { executed: false }; } }\n',
        files: {
          "first.ts":
            'import { second } from "./nested/second.js";\nexport function first() { return second(); }\n',
          "nested/second.ts":
            'import { first } from "../first.js";\nexport function second() { void first; return true; }\n',
        },
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Non-allowlisted runtime dependency "./first.js" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
    expect(execution.findings).toContain(
      'Non-allowlisted runtime dependency "./nested/second.js" found in plugins/plugin-paper-trading/src/first.ts.',
    );
  });

  test("requires a concrete synchronous no-op evaluate method", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness: "export class NoOpExecutionAdapter {}\n",
      }),
    );

    expect(execution.adapter).toBe("unknown");
    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      "NoOpExecutionAdapter must be a final single-method adapter with only evaluate().",
    );
  });

  test("rejects injected capability calls and overridable no-op receipts", async () => {
    const injected = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate(plan: any, intent: unknown, nowMs: number) { void intent; void nowMs; plan.broker.execute(); return { executed: false }; } }\n",
      }),
    );
    const spreadOverride = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate(plan: any, intent: unknown, nowMs: number) { void intent; void nowMs; return { executed: false, ...plan.receipt }; } }\n",
      }),
    );

    expect(injected.liveExecution).toBe("unknown");
    expect(injected.findings).toContain(
      "NoOpExecutionAdapter.evaluate() contains a non-allowlisted call expression.",
    );
    expect(spreadOverride.liveExecution).toBe("unknown");
    expect(spreadOverride.findings).toContain(
      "Every NoOpExecutionAdapter.evaluate() return must set executed to the false literal.",
    );
  });

  test("tracks aliased injected callables and browser transport roots", async () => {
    const aliased = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "function isRecord(value: any) { const sink = (value as any).transport; sink(); return true; }\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void intent; void nowMs; isRecord(plan); return { executed: false }; } }\n",
      }),
    );
    const browser = inspectExecutionSurface(
      await executionFixture({
        readiness:
          'function isRecord(value: unknown) { void value; document.createElement("form").submit(); return true; }\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void intent; void nowMs; isRecord(plan); return { executed: false }; } }\n',
      }),
    );
    const logicalAlias = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "function isRecord(value: any) { const sink = value && value.transport; sink(); return true; }\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void intent; void nowMs; isRecord(plan); return { executed: false }; } }\n",
      }),
    );

    expect(aliased.liveExecution).toBe("unknown");
    expect(aliased.findings).toContain(
      'Calling injected runtime parameter "sink" is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
    expect(browser.liveExecution).toBe("unknown");
    expect(browser.findings).toContain(
      'Forbidden execution capability "document" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
    expect(logicalAlias.liveExecution).toBe("unknown");
    expect(logicalAlias.findings).toContain(
      'Calling injected runtime parameter "sink" is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
  });

  test("rejects computed helper invocation and implicit adapter fallthrough", async () => {
    const computed = inspectExecutionSurface(
      await executionFixture({
        readiness: `import { helper } from "./helper.js";\n${minimalNoOpAdapter}`,
        files: {
          "helper.ts":
            'export function helper() { const sink = { post() {} }; sink["post"](); }\n',
        },
      }),
    );
    const fallthrough = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void nowMs; if (intent) return { executed: false }; } }\n",
      }),
    );

    expect(computed.liveExecution).toBe("unknown");
    expect(computed.findings).toContain(
      "Computed runtime invocation is forbidden in plugins/plugin-paper-trading/src/helper.ts.",
    );
    expect(fallthrough.liveExecution).toBe("unknown");
    expect(fallthrough.findings).toContain(
      "Every NoOpExecutionAdapter.evaluate() return must set executed to the false literal.",
    );
  });

  test("rejects executable index mutation and duplicate no-op exports", async () => {
    const mutation = inspectExecutionSurface(
      await executionFixture({
        index:
          'import { NoOpExecutionAdapter } from "./launch-readiness.js";\nNoOpExecutionAdapter.prototype.evaluate = () => ({ executed: false });\nexport { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
      }),
    );
    const duplicate = inspectExecutionSurface(
      await executionFixture({
        index:
          'export { NoOpExecutionAdapter, NoOpExecutionAdapter } from "./launch-readiness.js";\n',
      }),
    );

    expect(mutation.liveExecution).toBe("unknown");
    expect(mutation.findings).toContain(
      "plugins/plugin-paper-trading/src/index.ts must contain only static re-export declarations.",
    );
    expect(duplicate.liveExecution).toBe("unknown");
    expect(duplicate.findings).toContain(
      'NoOpExecutionAdapter must be directly re-exported exactly once from ./launch-readiness.js by canonical source plugins/plugin-paper-trading/src/index.ts.',
    );
  });

  test("rejects adapter replacement in readiness and new public runtime exports", async () => {
    const replacement = inspectExecutionSurface(
      await executionFixture({
        readiness: `${minimalNoOpAdapter}NoOpExecutionAdapter.prototype.evaluate = () => ({ executed: false });\n`,
      }),
    );
    const reassignment = inspectExecutionSurface(
      await executionFixture({
        readiness: `${minimalNoOpAdapter}NoOpExecutionAdapter = class { evaluate() { return { executed: false }; } };\n`,
      }),
    );
    const publicBroker = inspectExecutionSurface(
      await executionFixture({
        index:
          'export { NoOpExecutionAdapter } from "./launch-readiness.js";\nexport * from "./broker.js";\n',
        files: {
          "broker.ts": "export const Broker = class {};\n",
        },
      }),
    );
    const emptyExternalExport = inspectExecutionSurface(
      await executionFixture({
        index:
          'export { NoOpExecutionAdapter } from "./launch-readiness.js";\nexport {} from "broker-sdk";\n',
      }),
    );

    expect(replacement.liveExecution).toBe("unknown");
    expect(replacement.findings).toContain(
      "NoOpExecutionAdapter may not be referenced outside its class declaration in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    );
    expect(reassignment.liveExecution).toBe("unknown");
    expect(reassignment.findings).toContain(
      "NoOpExecutionAdapter may not be referenced outside its class declaration in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    );
    expect(publicBroker.liveExecution).toBe("unknown");
    expect(publicBroker.findings).toContain(
      "plugins/plugin-paper-trading/src/index.ts contains a non-allowlisted runtime re-export.",
    );
    expect(emptyExternalExport.liveExecution).toBe("unknown");
    expect(emptyExternalExport.findings).toContain(
      "plugins/plugin-paper-trading/src/index.ts contains an empty runtime re-export from broker-sdk.",
    );
  });

  test("rejects runtime JavaScript shadows for readiness and helper edges", async () => {
    const readinessShadow = inspectExecutionSurface(
      await executionFixture({
        files: {
          "launch-readiness.js":
            'export class NoOpExecutionAdapter { evaluate() { fetch("https://broker.invalid"); } }\n',
        },
      }),
    );
    const helperShadow = inspectExecutionSurface(
      await executionFixture({
        readiness: `import { helper } from "./helper.js";\n${minimalNoOpAdapter}`,
        files: {
          "helper.js": 'fetch("https://broker.invalid");\n',
          "helper.ts": "export function helper() { return true; }\n",
        },
      }),
    );

    expect(readinessShadow.liveExecution).toBe("unknown");
    expect(readinessShadow.findings).toContain(
      expect.stringContaining(
        "launch-readiness.js shadows its TypeScript source",
      ),
    );
    expect(helperShadow.liveExecution).toBe("unknown");
    expect(helperShadow.findings).toContain(
      expect.stringContaining("helper.js shadows its TypeScript source"),
    );
  });

  test("rejects decorators that can replace the adapter definition", async () => {
    const execution = inspectExecutionSurface(
      await executionFixture({
        readiness:
          "function replace(value: unknown) { return value; }\n@replace\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; return { executed: false }; } }\n",
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      "NoOpExecutionAdapter.evaluate() must be a synchronous public instance method.",
    );
  });

  test("binds the source hash to reachable local execution dependencies", async () => {
    const root = await executionFixture({
      readiness:
        'import { validate } from "./validation.js";\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void plan; void intent; void nowMs; void validate; return { executed: false }; } }\n',
      files: {
        "validation.ts": "export function validate() { return true; }\n",
      },
    });
    const initial = inspectExecutionSurface(root);
    await writeFile(
      join(
        root,
        "plugins",
        "plugin-paper-trading",
        "src",
        "validation.ts",
      ),
      "export function validate() { return false; }\n",
    );
    const changed = inspectExecutionSurface(root);

    expect(initial.liveExecution).toBe("unknown");
    expect(changed.liveExecution).toBe("unknown");
    expect(changed.sourceHash).not.toBe(initial.sourceHash);
  });

  test("reports an unreadable execution surface as unknown", () => {
    const result = inspectExecutionSurface(
      resolve(tmpdir(), "paper-status-does-not-exist"),
    );

    expect(result.adapter).toBe("unreadable");
    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain(
      "Could not discover paper execution surface",
    );
  });

  test("ignores decoy metadata on a non-canonical workspace", async () => {
    const root = await executionFixture();
    const duplicate = join(root, "plugins", "plugin-shadow");
    await mkdir(duplicate, { recursive: true });
    await writeFile(
      join(duplicate, "package.json"),
      `${JSON.stringify({
        name: "@elizaos/plugin-paper-trading",
        elizaos: { scripts: { paperStatus: true } },
      })}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe(false);
    expect(result.findings).toEqual([]);
  });

  test("fails closed when the canonical package disables its marker", async () => {
    const root = await executionFixture();
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "package.json"),
      `${JSON.stringify({
        name: "@elizaos/plugin-paper-trading",
        exports: { ".": { "eliza-source": { import: "./src/index.ts" } } },
        elizaos: { scripts: { paperStatus: false } },
      })}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain("paperStatus=true");
  });

  test("cannot redirect inspection away from the canonical public source", async () => {
    const root = await executionFixture();
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "decoy.ts"),
      "export class NoOpExecutionAdapter {}\n",
    );
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "package.json"),
      `${JSON.stringify({
        name: "@elizaos/plugin-paper-trading",
        exports: { ".": { "eliza-source": { import: "./src/decoy.ts" } } },
        elizaos: { scripts: { paperStatus: true } },
      })}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain("must bind");
  });

  test("detects live markers in the canonical public source despite a decoy file", async () => {
    const root = await executionFixture({
      index:
        'export { NoOpExecutionAdapter } from "./launch-readiness.js";\nexport const placeOrder = () => {};\n',
    });
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "decoy.ts"),
      "export class NoOpExecutionAdapter {}\n",
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings).toContain(
      'Possible live-execution call site "placeOrder" found in the paper-trading surface.',
    );
  });

  test("ignores commented decoy exports and inspects the fixed readiness source", async () => {
    const root = await executionFixture({
      readiness:
        "export class NoOpExecutionAdapter {}\nexport const placeOrder = () => {};\n",
      index:
        '// export { NoOpExecutionAdapter } from "./decoy.js";\nexport { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
    });
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "decoy.ts"),
      "export class NoOpExecutionAdapter {}\n",
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings).toContain(
      'Possible live-execution call site "placeOrder" found in the paper-trading surface.',
    );
  });

  test.each([
    'export type { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
    'export { type NoOpExecutionAdapter } from "./launch-readiness.js";\n',
    'export { NoOpExecutionAdapter as Renamed } from "./launch-readiness.js";\n',
    'export { Renamed as NoOpExecutionAdapter } from "./launch-readiness.js";\n',
  ])("rejects non-runtime or aliased no-op export: %s", async (index) => {
    const result = inspectExecutionSurface(await executionFixture({ index }));

    expect(result.liveExecution).toBe("unknown");
    expect(
      result.findings.some((finding) =>
        finding.includes("directly re-exported exactly once"),
      ),
    ).toBe(true);
  });

  test("binds the source hash to canonical metadata and both inspected sources", async () => {
    const root = await executionFixture();
    const initial = inspectExecutionSurface(root);
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "index.ts"),
      '// harmless public-source change\nexport { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
    );
    const indexChanged = inspectExecutionSurface(root);
    await writeFile(
      join(
        root,
        "plugins",
        "plugin-paper-trading",
        "src",
        "launch-readiness.ts",
      ),
      "// harmless readiness change\nexport class NoOpExecutionAdapter {}\n",
    );
    const readinessChanged = inspectExecutionSurface(root);

    expect(indexChanged.sourceHash).not.toBe(initial.sourceHash);
    expect(readinessChanged.sourceHash).not.toBe(indexChanged.sourceHash);
  });
});
