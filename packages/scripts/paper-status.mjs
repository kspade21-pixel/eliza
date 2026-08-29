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

const SCHEMA = "eliza-paper-status/1";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const LAUNCH_READINESS = "plugins/plugin-paper-trading/src/launch-readiness.ts";
const PLUGIN_INDEX = "plugins/plugin-paper-trading/src/index.ts";

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

function parseArgs(argv) {
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
function inspectExecutionSurface() {
  const findings = [];
  let readiness;
  try {
    readiness = readFileSync(resolve(REPO_ROOT, LAUNCH_READINESS), "utf8");
  } catch (cause) {
    return {
      adapter: "unreadable",
      liveExecution: "unknown",
      findings: [`Could not read ${LAUNCH_READINESS}: ${cause.message}`],
    };
  }

  const hasNoOpAdapter = /export\s+class\s+NoOpExecutionAdapter\b/.test(
    readiness,
  );
  if (!hasNoOpAdapter) {
    findings.push(
      `NoOpExecutionAdapter is no longer exported from ${LAUNCH_READINESS}.`,
    );
  }

  let index = "";
  try {
    index = readFileSync(resolve(REPO_ROOT, PLUGIN_INDEX), "utf8");
  } catch (cause) {
    findings.push(`Could not read ${PLUGIN_INDEX}: ${cause.message}`);
  }

  for (const marker of LIVE_EXECUTION_MARKERS) {
    if (readiness.includes(marker) || index.includes(marker)) {
      findings.push(
        `Possible live-execution call site "${marker}" found in the paper-trading surface.`,
      );
    }
  }

  return {
    adapter: hasNoOpAdapter ? "NoOpExecutionAdapter" : "unknown",
    liveExecution: findings.length === 0 ? false : "unknown",
    sourceHash: createHash("sha256")
      .update(readiness)
      .digest("hex")
      .slice(0, 16),
    findings,
  };
}

function main() {
  const { lanes, out, identity } = parseArgs(process.argv.slice(2));
  const execution = inspectExecutionSurface();

  const failed = lanes.filter((lane) => lane.status === "fail");
  const overall =
    failed.length > 0 || execution.liveExecution !== false ? "red" : "green";

  const runId = identity["run-id"];
  const repo = identity.repository;

  const record = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    overall,
    repository: repo,
    ref: identity.ref,
    commit: identity.commit,
    runId,
    runUrl:
      repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null,
    lanes,
    failingLanes: failed.map((lane) => lane.name),
    execution: {
      mode: "paper-only",
      adapter: execution.adapter,
      liveExecution: execution.liveExecution,
      sourceHash: execution.sourceHash ?? null,
      findings: execution.findings,
    },
  };

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(resolve(process.cwd(), out), serialized, "utf8");
  process.stdout.write(serialized);

  // A red record is a successful emission. The workflow decides what a red
  // status means for the job; this script's job is to report it accurately.
}

main();
