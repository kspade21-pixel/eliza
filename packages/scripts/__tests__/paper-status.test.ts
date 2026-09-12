/**
 * Proves the machine-readable paper health feed fails closed when required
 * verification lanes or the no-op execution boundary are incomplete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    writeFile(
      join(root, "plugins", "plugin-paper-trading", "tsconfig.build.json"),
      `${JSON.stringify(
        {
          extends: "../tsconfig.build.shared.json",
          compilerOptions: {
            allowImportingTsExtensions: false,
            declaration: true,
            declarationMap: true,
            emitDeclarationOnly: false,
            noEmit: false,
            outDir: "dist",
            rootDir: "src",
            rewriteRelativeImportExtensions: true,
          },
          include: ["src/**/*.ts"],
          exclude: ["test/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(root, "plugins", "tsconfig.build.shared.json"), "{}\n"),
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

async function canonicalExecutionFixture() {
  const root = await mkdtemp(join(tmpdir(), "paper-status-canonical-"));
  tempDirs.push(root);
  const sourcePackage = join(repoRoot, "plugins", "plugin-paper-trading");
  const targetPackage = join(root, "plugins", "plugin-paper-trading");
  await mkdir(targetPackage, { recursive: true });
  await Promise.all([
    cp(
      join(sourcePackage, "package.json"),
      join(targetPackage, "package.json"),
    ),
    cp(
      join(sourcePackage, "tsconfig.build.json"),
      join(targetPackage, "tsconfig.build.json"),
    ),
    cp(
      join(repoRoot, "plugins", "tsconfig.build.shared.json"),
      join(root, "plugins", "tsconfig.build.shared.json"),
    ),
    cp(join(sourcePackage, "src"), join(targetPackage, "src"), {
      recursive: true,
    }),
  ]);
  return { root, targetPackage };
}

function inspectFixtureSurface(
  root: string,
  expectedClosureSha256: string | null = null,
) {
  return inspectExecutionSurface(root, expectedClosureSha256);
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
  test("keeps the real paper adapter green with a pinned public runtime graph", () => {
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
    expect(result.sourceSha256).toHaveLength(64);
    expect(result.sourceHash).toBe(result.sourceSha256?.slice(0, 16));
  });

  test("recognizes the explicit no-op adapter in an otherwise clean surface", async () => {
    const result = inspectFixtureSurface(await executionFixture());

    expect(result).toEqual(
      expect.objectContaining({
        adapter: "NoOpExecutionAdapter",
        liveExecution: false,
        findings: [],
      }),
    );
  });

  test("requires the reviewed closure digest for every repository by default", async () => {
    const result = inspectExecutionSurface(await executionFixture());

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain("Execution closure digest changed");
  });

  test("rejects implicit invocation through await and parameter iteration", async () => {
    const awaited = inspectFixtureSurface(
      await executionFixture({
        readiness: `export async function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  await { then: state.hook };
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );
    const iterated = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  for (const ignored of ({ [Symbol.iterator]: state.hook } as any)) { void ignored; }
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(
      awaited.findings.some((finding) =>
        finding.includes("Implicit await/yield invocation is forbidden"),
      ),
    ).toBe(true);
    expect(
      iterated.findings.some((finding) =>
        finding.includes("parameter-derived iteration is forbidden"),
      ),
    ).toBe(true);
  });

  test.each([
    ["String", "toString"],
    ["Number", "valueOf"],
    ["BigInt", "valueOf"],
  ])(
    "rejects implicit invocation through parameter-derived %s coercion",
    async (coercion, hook) => {
      const execution = inspectFixtureSurface(
        await executionFixture({
          readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  ${coercion}({ ${hook}: state.hook });
  return { safe: true };
}
${minimalNoOpAdapter}`,
        }),
      );

      expect(
        execution.findings.some((finding) =>
          finding.includes("Non-allowlisted parameter-derived coercion"),
        ),
      ).toBe(true);
    },
  );

  test("rejects a parameter-derived iterable spread", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  void [...({ [Symbol.iterator]: state.hook } as any)];
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(
      execution.findings.some((finding) =>
        finding.includes("parameter-derived iterable spread is forbidden"),
      ),
    ).toBe(true);
  });

  test("rejects explicit resource-management hooks", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  using resource = state;
  void resource;
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(
      execution.findings.some((finding) =>
        finding.includes("Explicit resource-management hooks are forbidden"),
      ),
    ).toBe(true);
  });

  test("rejects implicit toJSON invocation through generic serialization", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  JSON.stringify({ toJSON: state.hook });
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(
      execution.findings.some((finding) =>
        finding.includes("non-reviewed receiver"),
      ),
    ).toBe(true);
  });

  test("rejects implicit coercion in an Error constructor", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  throw new Error({ toString: state.hook } as any);
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(
      execution.findings.some((finding) =>
        finding.includes("Non-allowlisted runtime construction"),
      ),
    ).toBe(true);
  });

  test.each([
    ["binary", "void (({ valueOf: state.hook } as any) + 1);"],
    [
      "template",
      "void `" +
        String.fromCharCode(36) +
        "{{ toString: state.hook } as any}`;",
    ],
  ])(
    "rejects %s coercion of a parameter-derived container",
    async (_name, expression) => {
      const execution = inspectFixtureSurface(
        await executionFixture({
          readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  ${expression}
  return { safe: true };
}
${minimalNoOpAdapter}`,
        }),
      );

      expect(
        execution.findings.some((finding) =>
          finding.includes(
            "Implicit coercion of a parameter-derived container is forbidden",
          ),
        ),
      ).toBe(true);
    },
  );

  test("reports a live-execution marker as unknown and forces red", async () => {
    const execution = inspectFixtureSurface(
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
  ])(
    "rejects %s in the canonical adapter",
    async (_name, readiness, finding) => {
      const execution = inspectFixtureSurface(
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
    },
  );

  test("rejects a network call hidden in a reachable local helper", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { postOrder } from "./broker-helper.js";\n${noOpAdapterWithBody(
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
    const execution = inspectFixtureSurface(
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
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { request } from "node:https";\n${noOpAdapterWithBody(
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
    const execution = inspectFixtureSurface(
      await executionFixture({ readiness: noOpAdapterWithBody(body) }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(finding);
  });

  test("ignores capability names in comments, strings, and type-only imports", async () => {
    const execution = inspectFixtureSurface(
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
    const missing = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { helper } from "./missing.js";\n${noOpAdapterWithBody(
          "helper();",
        )}`,
      }),
    );
    const escaped = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { helper } from "../../../outside.js";\n${noOpAdapterWithBody(
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
    const malformedAdapter = inspectFixtureSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate( { return { executed: false }; } }\n",
      }),
    );
    const malformedHelper = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { helper } from "./helper.js";\n${noOpAdapterWithBody(
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
    const execution = inspectFixtureSurface(
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
    const execution = inspectFixtureSurface(
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
    const injected = inspectFixtureSurface(
      await executionFixture({
        readiness:
          "export class NoOpExecutionAdapter { evaluate(plan: any, intent: unknown, nowMs: number) { void intent; void nowMs; plan.broker.execute(); return { executed: false }; } }\n",
      }),
    );
    const spreadOverride = inspectFixtureSurface(
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

  test("rejects safe-named methods reached through injected parameters", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function isRecord(value: any) { value.transport.map("https://broker.invalid/orders", { method: "POST" }); return true; }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      "Calling injected runtime capability through a parameter is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    );
  });

  test("rejects injected capabilities laundered through objects and wrappers", async () => {
    const objectAlias = inspectFixtureSurface(
      await executionFixture({
        readiness: `function isRecord(value: any) { const transport = value.transport; const box = { transport }; const sink = box.transport; sink("https://broker.invalid/orders", { method: "POST" }); return true; }\n${minimalNoOpAdapter}`,
      }),
    );
    const wrappedAlias = inspectFixtureSurface(
      await executionFixture({
        readiness: `function passthrough(value: any) { return value; }\nfunction isRecord(value: any) { const box = passthrough({ ...value }); const sink = box.transport; sink("https://broker.invalid/orders", { method: "POST" }); return true; }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(objectAlias.liveExecution).toBe("unknown");
    expect(objectAlias.findings).toContain(
      'Calling injected runtime parameter "sink" is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
    expect(wrappedAlias.liveExecution).toBe("unknown");
    expect(wrappedAlias.findings).toContain(
      'Calling injected runtime parameter "sink" is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
  });

  test("tracks aliased injected callables and browser transport roots", async () => {
    const aliased = inspectFixtureSurface(
      await executionFixture({
        readiness:
          "function isRecord(value: any) { const sink = (value as any).transport; sink(); return true; }\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void intent; void nowMs; isRecord(plan); return { executed: false }; } }\n",
      }),
    );
    const browser = inspectFixtureSurface(
      await executionFixture({
        readiness:
          'function isRecord(value: unknown) { void value; document.createElement("form").submit(); return true; }\nexport class NoOpExecutionAdapter { evaluate(plan: unknown, intent: unknown, nowMs: number) { void intent; void nowMs; isRecord(plan); return { executed: false }; } }\n',
      }),
    );
    const logicalAlias = inspectFixtureSurface(
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

  test("permits the reviewed zero-argument primitive call chain", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function normalizePolicy(policy: any) { return policy.symbolAllowlist.map((symbol: string) => symbol.trim().toUpperCase()); }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe(false);
    expect(execution.findings).toEqual([]);
  });

  test("rejects a trusted receiver name backed by injected state", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function buildPaperDryRunPlan(state: any, order: any, policy?: any) { void policy; const previewEngine = order.useFresh ? new PaperTradingEngine({}) : state; return previewEngine.execute(order); }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      "Calling injected runtime capability through a parameter is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    );
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("Rejected parameter-derived call at") &&
          finding.includes("(buildPaperDryRunPlan)"),
      ),
    ).toBe(true);
  });

  test("rejects a spoofed reviewed regex receiver that stores an injected callable", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `const CANONICAL_INTEGER: any = {
  slot: null,
  test(value: unknown) { this.slot = value; return true; },
  run() { this.slot(); },
};
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void state;
  void policy;
  CANONICAL_INTEGER.test(order.hook);
  CANONICAL_INTEGER.run();
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Rejected parameter-derived call at"),
      ),
    ).toBe(true);
  });

  test("rejects a runtime namespace that shadows a reviewed builtin", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `namespace Object {
  export const keys: { (this: any, value: any): any[] } = function (value) { this.slot = value; return []; };
  export const run: { (this: any): void } = function () { this.slot(); };
}
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  Object.keys(state);
  Object.run();
  return { safe: true };
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Runtime namespace declarations are forbidden"),
      ),
    ).toBe(true);
  });

  test("rejects decorators that implicitly call an injected capability", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `export function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void order;
  void policy;
  @(state.decorator)
  class Trigger {}
  return Trigger;
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Decorator execution is forbidden"),
      ),
    ).toBe(true);
  });

  test("rejects replacement of a reviewed static receiver method", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `const CANONICAL_INTEGER = /^(?:0|-?[1-9]\\d*)$/;
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void state;
  void policy;
  CANONICAL_INTEGER.test = order.hook;
  return CANONICAL_INTEGER.test("1");
}
${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Mutation of a trusted runtime binding or callable"),
      ),
    ).toBe(true);
  });

  test.each([
    ["property alias", "const mutate = Object.defineProperty;"],
    ["destructured alias", "const { defineProperty: mutate } = Object;"],
    [
      "transitively wrapped alias",
      "const box = { Object }; const { Object: ObjectAlias } = box; const { defineProperty: mutate } = ObjectAlias;",
    ],
    [
      "template-computed alias",
      "const mutate = Object[`define$" + '{"Property"}`];',
    ],
  ])("rejects a %s that replaces a trusted method", async (_name, alias) => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  const previewEngine = new PaperTradingEngine(policy);
  ${alias}
  mutate(previewEngine, "execute", { value: state.transport });
  return previewEngine.execute(order);
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("runtime binding may not be captured") ||
          finding.includes("mutation capability may not be captured"),
      ),
    ).toBe(true);
  });

  test("rejects a parameter-derived write into a trusted receiver", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  const previewEngine = new PaperTradingEngine(policy);
  previewEngine.ledger = state;
  return previewEngine.execute(order);
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Non-allowlisted trusted receiver write"),
      ),
    ).toBe(true);
  });

  test("rejects a computed write through an injected receiver", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function normalizePolicy(policy: any) {
  const field = "sink";
  policy[field] = 1;
  return policy.symbolAllowlist.map((symbol: string) => symbol.trim().toUpperCase());
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("Non-allowlisted computed runtime access") ||
          finding.includes("Mutation through a parameter-derived receiver"),
      ),
    ).toBe(true);
  });

  test.each([
    ["delete", "delete policy.sink;"],
    ["postfix update", "policy.sink++;"],
    ["prefix update", "++policy.sink;"],
    ["iteration target", "for (policy.sink of [1]) {}"],
    ["destructuring target", "({ x: policy.sink } = { x: 1 });"],
  ])("rejects a %s through an injected receiver", async (_name, mutation) => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function normalizePolicy(policy: any) {
  ${mutation}
  return policy.symbolAllowlist.map((symbol: string) => symbol.trim().toUpperCase());
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("Non-allowlisted runtime mutation") ||
          finding.includes("Non-allowlisted runtime write"),
      ),
    ).toBe(true);
  });

  test.each([
    ["object", "({ previewEngine } = state);"],
    ["array", "[previewEngine] = state.engines;"],
  ])(
    "rejects %s-destructuring reassignment of a trusted receiver",
    async (_name, reassignment) => {
      const execution = inspectFixtureSurface(
        await executionFixture({
          readiness: `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  let previewEngine = new PaperTradingEngine(policy);
  ${reassignment}
  return previewEngine.execute(order);
}\n${minimalNoOpAdapter}`,
        }),
      );

      expect(execution.liveExecution).toBe("unknown");
      expect(execution.findings).toContain(
        "Calling injected runtime capability through a parameter is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.",
      );
    },
  );

  test.each([
    [
      "closure storage",
      `let slot: unknown;
function stash(value: unknown) { slot = value; }
function take() { return slot; }
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  let previewEngine = new PaperTradingEngine(policy);
  stash(state);
  previewEngine = take() as any;
  return previewEngine.execute(order);
}`,
    ],
    [
      "array storage",
      `const values: unknown[] = [];
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  let previewEngine = new PaperTradingEngine(policy);
  values.push(state);
  previewEngine = values.pop() as any;
  return previewEngine.execute(order);
}`,
    ],
    [
      "computed property storage",
      `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void policy;
  const cell: any = {};
  cell["slot"] = state;
  const previewEngine = cell["slot"];
  return previewEngine.execute(order);
}`,
    ],
    [
      "array fill storage",
      `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void policy;
  const values: any[] = [null];
  values.fill(state);
  const previewEngine = values.at(0);
  return previewEngine.execute(order);
}`,
    ],
    [
      "generic object method storage",
      `const box: any = {
  value: null,
  stash(value: unknown) { this.value = value; },
  take() { return this.value; },
};
function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void policy;
  box.stash(state);
  const previewEngine = box.take();
  return previewEngine.execute(order);
}`,
    ],
    [
      "constructed map storage",
      `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  void policy;
  const cell = new Map([["engine", state]]);
  const previewEngine = cell.get("engine");
  return previewEngine.execute(order);
}`,
    ],
  ])("rejects parameter laundering through %s", async (_name, body) => {
    const execution = inspectFixtureSurface(
      await executionFixture({ readiness: `${body}\n${minimalNoOpAdapter}` }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("Parameter-derived value may not escape") ||
          finding.includes("Calling injected runtime capability") ||
          finding.includes("Parameter-derived value may not be passed"),
      ),
    ).toBe(true);
  });

  test("rejects computed module loading capability capture", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `const load = (import.meta as any)["require"];
const net = load("node:https");
net.request("https://broker.invalid", { method: "POST" }).end();
${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Forbidden execution capability "require" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
  });

  test.each([
    [
      "constructor",
      `const key = \`con${"structor"}\`;
const Factory = (() => {})[key as "constructor"] as FunctionConstructor;
const run = Factory('return fetch("https://broker.invalid/orders", { method: "POST" })');
run();`,
    ],
    [
      "module loader",
      `const key = "require";
const load = (import.meta as any)[key];
const net = load("node:https");
net.request("https://broker.invalid", { method: "POST" }).end();`,
    ],
  ])(
    "rejects %s capture through a computed-key variable",
    async (_name, body) => {
      const execution = inspectFixtureSurface(
        await executionFixture({ readiness: `${body}\n${minimalNoOpAdapter}` }),
      );

      expect(execution.liveExecution).toBe("unknown");
      expect(
        execution.findings.some((finding) =>
          finding.includes("Non-allowlisted computed runtime access"),
        ),
      ).toBe(true);
    },
  );

  test("rejects legacy prototype accessor mutation", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function buildPaperDryRunPlan(state: any, order: any, policy?: any) {
  PaperTradingEngine.prototype.__defineGetter__("execute", () => state.execute);
  const previewEngine = new PaperTradingEngine(policy);
  return previewEngine.execute(order);
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Runtime reflection or mutation"),
      ),
    ).toBe(true);
  });

  test("rejects reviewed function names with substituted parameter roles", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function normalizePolicy(value: any) { return value.symbolAllowlist.map((symbol: string) => symbol); }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some(
        (finding) =>
          finding.includes("Reviewed function signature changed") &&
          finding.includes("(normalizePolicy)"),
      ),
    ).toBe(true);
  });

  test("rejects a lookalike reconstructed policy with untrusted provenance", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function recomputePlanHash(plan: any) {
  const policy = plan.effectivePolicy;
  const replayPolicy = {
    initialCashMicros: policy.initialCashMicros,
    maxOrderMicros: BigInt(policy.maxOrderMicros),
    maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
    maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
    minCashReserveMicros: BigInt(policy.minCashReserveMicros),
    maxDailyLossMicros: BigInt(policy.maxDailyLossMicros),
    feeBps: BigInt(policy.feeBps),
    slippageBps: BigInt(policy.slippageBps),
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    symbolAllowlist: policy.symbolAllowlist,
  };
  return replayPolicy.symbolAllowlist.includes("BTC");
}\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      "Calling injected runtime capability through a parameter is forbidden in plugins/plugin-paper-trading/src/launch-readiness.ts.",
    );
  });

  test("rejects reflection that hides constructor and transport recovery", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: noOpAdapterWithBody(
          `const Factory = Reflect.get("", "constructor"); const post = Reflect.apply(Factory, undefined, ['return fetch(arguments[0], {method: "POST"})']); void post;`,
        ),
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings).toContain(
      'Forbidden execution capability "Reflect" found in plugins/plugin-paper-trading/src/launch-readiness.ts.',
    );
  });

  test.each([
    ["object mutation", "Object.assign({}, { execute() {} });"],
    ["tagged invocation", "const tag = String.raw; tag`execute`;"],
    [
      "parameter-derived construction",
      "function isRecord(value: any) { new value.transport(); return true; }",
    ],
    [
      "runtime accessor",
      "const capability = { get execute() { return () => undefined; } }; void capability;",
    ],
    [
      "destructured constructor",
      "function isRecord(value: any) { const { constructor } = value; void constructor; return true; }",
    ],
    [
      "computed constructor recovery",
      'const Factory = ""["con" + "structor"]; void Factory;',
    ],
    [
      "trusted receiver method mutation",
      "function normalizePolicy(policy: any) { policy.symbolAllowlist.map = () => []; return policy; }",
    ],
    ["trusted factory mutation", "createHash = () => undefined;"],
    [
      "trusted runtime capture",
      "const ObjectAlias = Object; ObjectAlias.defineProperty({}, 'execute', { value: undefined });",
    ],
    [
      "trusted runtime shadowing",
      "function isRecord(value: any) { const Object = value; void Object; return true; }",
    ],
  ])("rejects %s", async (_name, body) => {
    const execution = inspectFixtureSurface(
      await executionFixture({ readiness: `${body}\n${minimalNoOpAdapter}` }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(execution.findings.length).toBeGreaterThan(0);
  });

  test("rejects a callable laundered through a parameter-capturing closure", async () => {
    const execution = inspectFixtureSurface(
      await executionFixture({
        readiness: `function isRecord(value: any) { const sink = getSink(); function getSink() { return value.transport; } sink(); return true; }\n${minimalNoOpAdapter}`,
      }),
    );

    expect(execution.liveExecution).toBe("unknown");
    expect(
      execution.findings.some((finding) =>
        finding.includes("Calling injected runtime parameter"),
      ),
    ).toBe(true);
  });

  test("rejects computed helper invocation and implicit adapter fallthrough", async () => {
    const computed = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { helper } from "./helper.js";\n${minimalNoOpAdapter}`,
        files: {
          "helper.ts":
            'export function helper() { const sink = { post() {} }; sink["post"](); }\n',
        },
      }),
    );
    const fallthrough = inspectFixtureSurface(
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
    const mutation = inspectFixtureSurface(
      await executionFixture({
        index:
          'import { NoOpExecutionAdapter } from "./launch-readiness.js";\nNoOpExecutionAdapter.prototype.evaluate = () => ({ executed: false });\nexport { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
      }),
    );
    const duplicate = inspectFixtureSurface(
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
      "NoOpExecutionAdapter must be directly re-exported exactly once from ./launch-readiness.js by canonical source plugins/plugin-paper-trading/src/index.ts.",
    );
  });

  test("rejects adapter replacement in readiness and new public runtime exports", async () => {
    const replacement = inspectFixtureSurface(
      await executionFixture({
        readiness: `${minimalNoOpAdapter}NoOpExecutionAdapter.prototype.evaluate = () => ({ executed: false });\n`,
      }),
    );
    const reassignment = inspectFixtureSurface(
      await executionFixture({
        readiness: `${minimalNoOpAdapter}NoOpExecutionAdapter = class { evaluate() { return { executed: false }; } };\n`,
      }),
    );
    const publicBroker = inspectFixtureSurface(
      await executionFixture({
        index:
          'export { NoOpExecutionAdapter } from "./launch-readiness.js";\nexport * from "./broker.js";\n',
        files: {
          "broker.ts": "export const Broker = class {};\n",
        },
      }),
    );
    const emptyExternalExport = inspectFixtureSurface(
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
    const readinessShadow = inspectFixtureSurface(
      await executionFixture({
        files: {
          "launch-readiness.js":
            'export class NoOpExecutionAdapter { evaluate() { fetch("https://broker.invalid"); } }\n',
        },
      }),
    );
    const helperShadow = inspectFixtureSurface(
      await executionFixture({
        readiness: `import { helper } from "./helper.js";\n${minimalNoOpAdapter}`,
        files: {
          "helper.js": 'fetch("https://broker.invalid");\n',
          "helper.ts": "export function helper() { return true; }\n",
        },
      }),
    );

    expect(readinessShadow.liveExecution).toBe("unknown");
    expect(
      readinessShadow.findings.some((finding) =>
        finding.includes("launch-readiness.js shadows its TypeScript source"),
      ),
    ).toBe(true);
    expect(helperShadow.liveExecution).toBe("unknown");
    expect(
      helperShadow.findings.some((finding) =>
        finding.includes("helper.js shadows its TypeScript source"),
      ),
    ).toBe(true);
  });

  test("rejects decorators that can replace the adapter definition", async () => {
    const execution = inspectFixtureSurface(
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
    const initial = inspectFixtureSurface(root);
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "validation.ts"),
      "export function validate() { return false; }\n",
    );
    const changed = inspectFixtureSurface(root);

    expect(initial.liveExecution).toBe("unknown");
    expect(changed.liveExecution).toBe("unknown");
    expect(changed.sourceHash).not.toBe(initial.sourceHash);
  });

  test("fails closed when a pinned clean execution closure changes", async () => {
    const root = await executionFixture();
    const initial = inspectFixtureSurface(root);
    await writeFile(
      join(
        root,
        "plugins",
        "plugin-paper-trading",
        "src",
        "launch-readiness.ts",
      ),
      `${minimalNoOpAdapter} `,
    );
    const changed = inspectFixtureSurface(root, initial.sourceSha256);

    expect(initial.liveExecution).toBe(false);
    expect(initial.findings).toEqual([]);
    expect(changed.liveExecution).toBe("unknown");
    expect(changed.findings).toEqual([
      expect.stringContaining("Execution closure digest changed"),
    ]);
  });

  test("default digest includes non-readiness public runtime dependencies", async () => {
    const { root, targetPackage } = await canonicalExecutionFixture();

    const initial = inspectExecutionSurface(root);
    const actionPath = join(targetPackage, "src", "action.ts");
    const action = await readFile(actionPath, "utf8");
    await writeFile(
      actionPath,
      `${action}\nvoid fetch("https://broker.invalid/orders", { method: "POST" });\n`,
    );
    const changed = inspectExecutionSurface(root);

    expect(initial.liveExecution).toBe(false);
    expect(initial.findings).toEqual([]);
    expect(changed.liveExecution).toBe("unknown");
    expect(changed.sourceSha256).not.toBe(initial.sourceSha256);
    expect(changed.findings).toEqual([
      expect.stringContaining("Execution closure digest changed"),
    ]);
  });

  test("rejects a build config that redirects the emitted default entry", async () => {
    const { root, targetPackage } = await canonicalExecutionFixture();
    const alternate = join(targetPackage, "alternate-runtime");
    await mkdir(alternate, { recursive: true });
    await writeFile(
      join(alternate, "index.ts"),
      'void fetch("https://broker.invalid/orders", { method: "POST" });\n',
    );
    await writeFile(
      join(targetPackage, "tsconfig.build.json"),
      `${JSON.stringify(
        {
          extends: "../tsconfig.build.shared.json",
          compilerOptions: {
            allowImportingTsExtensions: false,
            declaration: true,
            declarationMap: true,
            emitDeclarationOnly: false,
            noEmit: false,
            outDir: "dist",
            rootDir: "alternate-runtime",
            rewriteRelativeImportExtensions: true,
          },
          include: ["alternate-runtime/**/*.ts"],
          exclude: ["test/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain(
      "tsconfig.build.json must include only src/**/*.ts",
    );
  });

  test("reports an unreadable execution surface as unknown", () => {
    const result = inspectFixtureSurface(
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

    const result = inspectFixtureSurface(root);

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

    const result = inspectFixtureSurface(root);

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

    const result = inspectFixtureSurface(root);

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

    const result = inspectFixtureSurface(root);

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

    const result = inspectFixtureSurface(root);

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
    const result = inspectFixtureSurface(await executionFixture({ index }));

    expect(result.liveExecution).toBe("unknown");
    expect(
      result.findings.some((finding) =>
        finding.includes("directly re-exported exactly once"),
      ),
    ).toBe(true);
  });

  test("binds the source hash to raw metadata and inspected sources", async () => {
    const root = await executionFixture();
    const initial = inspectFixtureSurface(root);
    const manifestPath = join(
      root,
      "plugins",
      "plugin-paper-trading",
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, description: "digest probe" }, null, 2)}\n`,
    );
    const manifestChanged = inspectFixtureSurface(root);
    const sharedBuildConfigPath = join(
      root,
      "plugins",
      "tsconfig.build.shared.json",
    );
    const sharedBuildConfig = await readFile(sharedBuildConfigPath, "utf8");
    await writeFile(sharedBuildConfigPath, `${sharedBuildConfig} `);
    const sharedBuildConfigChanged = inspectFixtureSurface(root);
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "src", "index.ts"),
      '// harmless public-source change\nexport { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
    );
    const indexChanged = inspectFixtureSurface(root);
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
    const readinessChanged = inspectFixtureSurface(root);

    expect(manifestChanged.sourceHash).not.toBe(initial.sourceHash);
    expect(sharedBuildConfigChanged.sourceHash).not.toBe(
      manifestChanged.sourceHash,
    );
    expect(indexChanged.sourceHash).not.toBe(
      sharedBuildConfigChanged.sourceHash,
    );
    expect(readinessChanged.sourceHash).not.toBe(indexChanged.sourceHash);
  });
});
