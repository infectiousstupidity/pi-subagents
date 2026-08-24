#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BasicSubagentParams,
  BASIC_SUBAGENT_TOOL_DESCRIPTION,
  BASIC_SUBAGENT_PROMPT_SNIPPET,
  SubagentCapabilityParams,
  SUBAGENT_CAPABILITY_DESCRIPTION,
} from "../../src/extension/context-surface-contract.ts";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(here, "..");
const repoRoot = path.resolve(benchmarkDir, "..");
const config = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "benchmark.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
if (pkg.name !== "pi-subagents") throw new Error(`Expected pi-subagents repo, got ${pkg.name ?? "unknown"}`);

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "unknown";
  }
}
function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const commit = run("git", ["rev-parse", "HEAD"]);
const shortCommit = commit === "unknown" ? "unknown" : commit.slice(0, 8);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runId = `${stamp}-${shortCommit}-${crypto.randomBytes(2).toString("hex")}`;
const resultsRoot = expandHome(config.resultsRoot);
const runsRoot = path.join(resultsRoot, "runs");
const runDir = path.join(runsRoot, runId);
const workspace = path.join(runDir, "workspace");
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(runDir, { recursive: false });

write(path.join(workspace, "facts", "alpha.txt"), "17\n");
write(path.join(workspace, "facts", "beta.txt"), "23\n");
write(path.join(workspace, "facts", "gamma.txt"), "41\n");
write(path.join(workspace, "facts", "workflow-seed.txt"), "19\n");
write(path.join(workspace, "facts", "async.txt"), "ready\n");
write(path.join(workspace, "code", "normalize.mjs"), 'export function normalizeName(value) {\n  return value.trim().toLowerCase().replace(/\\s+/, "-");\n}\n');
write(path.join(workspace, "code", "test", "normalize.test.mjs"), `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { normalizeName } from "../normalize.mjs";\n\ntest("collapses every whitespace run", () => {\n  assert.equal(normalizeName("  Alpha   Beta   Gamma  "), "alpha-beta-gamma");\n});\n\ntest("handles mixed whitespace", () => {\n  assert.equal(normalizeName("One\\tTwo\\nThree"), "one-two-three");\n});\n`);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const minimalSchemaBytes = bytes(BasicSubagentParams);
const fullSchema = createSubagentParamsSchema();
const fullSchemaBytes = bytes(fullSchema);
let unitTestPass = false;
let unitTestOutput = "";
try {
  unitTestOutput = execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--import", "./test/support/isolated-temp-root.mjs",
    "--test", "test/unit/context-surface.test.ts",
  ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  unitTestPass = true;
} catch (error) {
  unitTestOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
const staticMetrics = {
  minimalSchemaBytes,
  fullSchemaBytes,
  minimalToFullRatio: Number((minimalSchemaBytes / fullSchemaBytes).toFixed(6)),
  minimalFieldCount: Object.keys(BasicSubagentParams.properties ?? {}).length,
  fullFieldCount: Object.keys(fullSchema.properties ?? {}).length,
  minimalDescriptionBytes: Buffer.byteLength(BASIC_SUBAGENT_TOOL_DESCRIPTION),
  minimalPromptSnippetBytes: Buffer.byteLength(BASIC_SUBAGENT_PROMPT_SNIPPET),
  capabilitySchemaBytes: bytes(SubagentCapabilityParams),
  capabilityDescriptionBytes: Buffer.byteLength(SUBAGENT_CAPABILITY_DESCRIPTION),
  unitTestPass,
  unitTestOutput: unitTestOutput.trim().slice(-4000),
  thresholds: { minimalSchemaBytesMaxExclusive: 3500, minimalToFullRatioMaxExclusive: 0.25 },
};
staticMetrics.pass = minimalSchemaBytes < 3500 && minimalSchemaBytes * 4 < fullSchemaBytes && unitTestPass;
write(path.join(runDir, "static.json"), `${JSON.stringify(staticMetrics, null, 2)}\n`);

const meta = {
  benchmark: config.name,
  benchmarkVersion: config.version,
  runId,
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  repoRoot,
  packageVersion: pkg.version,
  commit,
  branch: run("git", ["branch", "--show-current"]),
  repoDirty: run("git", ["status", "--porcelain"]) !== "",
  piVersion: run("pi", ["--version"]),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  hostname: os.hostname(),
  runDir,
  workspace,
};
write(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ runId, runDir, workspace, packageVersion: pkg.version, commit, benchmarkVersion: config.version, staticPass: staticMetrics.pass }, null, 2)}\n`);
