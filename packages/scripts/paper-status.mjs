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
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertContainedRegularFile } from "./lib/repository-file-integrity.mjs";
import { listPackages } from "./lib/workspaces.mjs";

const SCHEMA = "eliza-paper-status/1";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const NO_OP_ADAPTER = "NoOpExecutionAdapter";
export const REQUIRED_PAPER_LANES = Object.freeze([
  "install",
  "build-core",
  "paper-typecheck",
  "paper-tests",
  "status-contract",
  "sdk-routes",
]);

/** Markers that would indicate a real order path replaced the no-op adapter. */
const LIVE_EXECUTION_MARKERS = [
  "createOrder",
  "submitOrder",
  "placeOrder",
  "sendTransaction",
  "signAndSend",
];

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
  const findings = [];
  let declaration;
  try {
    const declared = listPackages({ repoRoot }).filter((pkg) =>
      Object.hasOwn(pkg.packageJson.elizaos?.scripts ?? {}, "paperStatus"),
    );
    if (declared.length !== 1) {
      throw new Error(
        `expected exactly one workspace to declare elizaos.scripts.paperStatus, found ${declared.length}`,
      );
    }
    const pkg = declared[0];
    const surface =
      pkg.packageJson.elizaos.scripts.paperStatus?.executionSurface;
    if (
      !surface ||
      typeof surface !== "object" ||
      typeof surface.readiness !== "string" ||
      typeof surface.index !== "string"
    ) {
      throw new Error(
        `${pkg.dir}/package.json has malformed elizaos.scripts.paperStatus.executionSurface metadata`,
      );
    }
    declaration = {
      readiness: `${pkg.dir}/${surface.readiness}`,
      index: `${pkg.dir}/${surface.index}`,
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

  let readiness;
  try {
    readiness = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        declaration.readiness,
        "paper execution readiness source",
      ).absolute,
      "utf8",
    );
  } catch (cause) {
    return {
      adapter: "unreadable",
      liveExecution: "unknown",
      findings: [`Could not read ${declaration.readiness}: ${cause.message}`],
    };
  }

  const hasNoOpAdapter = new RegExp(
    `export\\s+class\\s+${NO_OP_ADAPTER}\\b`,
  ).test(readiness);
  if (!hasNoOpAdapter) {
    findings.push(
      `${NO_OP_ADAPTER} is no longer exported from ${declaration.readiness}.`,
    );
  }

  let index = "";
  try {
    index = readFileSync(
      assertContainedRegularFile(
        repoRoot,
        declaration.index,
        "paper execution index source",
      ).absolute,
      "utf8",
    );
  } catch (cause) {
    findings.push(`Could not read ${declaration.index}: ${cause.message}`);
  }

  for (const marker of LIVE_EXECUTION_MARKERS) {
    if (readiness.includes(marker) || index.includes(marker)) {
      findings.push(
        `Possible live-execution call site "${marker}" found in the paper-trading surface.`,
      );
    }
  }

  return {
    adapter: hasNoOpAdapter ? NO_OP_ADAPTER : "unknown",
    liveExecution: findings.length === 0 ? false : "unknown",
    sourceHash: createHash("sha256")
      .update(readiness)
      .digest("hex")
      .slice(0, 16),
    findings,
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
