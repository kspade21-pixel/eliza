/**
 * Proves the machine-readable paper health feed fails closed when required
 * verification lanes or the no-op execution boundary are incomplete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assessPaperLanes,
  buildPaperStatusRecord,
  inspectExecutionSurface,
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
  readiness = "export class NoOpExecutionAdapter {}\n",
  index = 'export { NoOpExecutionAdapter } from "./launch-readiness.js";\n',
}: {
  readiness?: string;
  index?: string;
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
          elizaos: {
            scripts: {
              paperStatus: {
                executionSurface: {
                  readiness: "src/launch-readiness.ts",
                  index: "src/index.ts",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(source, "launch-readiness.ts"), readiness),
    writeFile(join(source, "index.ts"), index),
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
    const [nightly, staticSmoke] = await Promise.all([
      readFile(
        join(repoRoot, ".github", "workflows", "paper-nightly.yml"),
        "utf8",
      ),
      readFile(
        join(repoRoot, ".github", "workflows", "pr-static-smoke.yml"),
        "utf8",
      ),
    ]);
    const emittedLanes = [...nightly.matchAll(/--lane=([^=\s]+)=/g)].map(
      (match) => match[1],
    );

    expect(emittedLanes).toEqual([...REQUIRED_PAPER_LANES]);
    expect(nightly).toContain("id: status_contract");
    expect(nightly).toContain(
      "bun test packages/scripts/__tests__/paper-status.test.ts",
    );
    expect(staticSmoke).toContain(
      "bun test packages/scripts/__tests__/paper-status.test.ts",
    );
  });
});

describe("paper status execution boundary", () => {
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

  test("fails closed when more than one workspace declares the surface", async () => {
    const root = await executionFixture();
    const duplicate = join(root, "plugins", "plugin-shadow");
    await mkdir(duplicate, { recursive: true });
    await writeFile(
      join(duplicate, "package.json"),
      `${JSON.stringify({
        name: "@elizaos/plugin-shadow",
        elizaos: {
          scripts: {
            paperStatus: {
              executionSurface: { readiness: "src/a.ts", index: "src/b.ts" },
            },
          },
        },
      })}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain(
      "expected exactly one workspace to declare",
    );
  });

  test("fails closed on malformed package-owned surface metadata", async () => {
    const root = await executionFixture();
    await writeFile(
      join(root, "plugins", "plugin-paper-trading", "package.json"),
      `${JSON.stringify({
        name: "@elizaos/plugin-paper-trading",
        elizaos: { scripts: { paperStatus: {} } },
      })}\n`,
    );

    const result = inspectExecutionSurface(root);

    expect(result.liveExecution).toBe("unknown");
    expect(result.findings[0]).toContain("malformed");
  });
});
