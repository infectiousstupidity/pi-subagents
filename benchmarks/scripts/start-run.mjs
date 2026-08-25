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
if (pkg.name !== "pi-subagents") throw new Error(`Expected pi-subagents package, got ${pkg.name ?? "unknown"}`);

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
function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

const commit = run("git", ["rev-parse", "HEAD"]);
const shortCommit = commit === "unknown" ? "unknown" : commit.slice(0, 8);
const gitStatus = run("git", ["status", "--porcelain"]);
const gitDiffStat = run("git", ["diff", "--stat", "HEAD", "--"]);
const repoDirty = gitStatus !== "unknown" && gitStatus.length > 0;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runId = `${stamp}-${shortCommit}-${crypto.randomBytes(2).toString("hex")}`;
const resultsRoot = expandHome(config.resultsRoot);
const runDir = path.join(resultsRoot, "runs", runId);
const workspace = path.join(runDir, "workspace");
fs.mkdirSync(path.dirname(runDir), { recursive: true });
fs.mkdirSync(runDir, { recursive: false });

write(path.join(workspace, "facts", "alpha.txt"), "17\n");
write(path.join(workspace, "facts", "beta.txt"), "23\n");
write(path.join(workspace, "facts", "gamma.txt"), "41\n");
write(path.join(workspace, "facts", "workflow-seed.txt"), "19\n");
write(path.join(workspace, "facts", "async.txt"), "ready\n");
write(path.join(workspace, "code", "normalize.mjs"), 'export function normalizeName(value) {\n  return value.trim().toLowerCase().replace(/\\s+/, "-");\n}\n');
write(path.join(workspace, "code", "test", "normalize.test.mjs"), `import assert from "node:assert/strict";
import test from "node:test";
import { normalizeName } from "../normalize.mjs";

test("collapses every whitespace run", () => {
  assert.equal(normalizeName("  Alpha   Beta   Gamma  "), "alpha-beta-gamma");
});

test("handles mixed whitespace", () => {
  assert.equal(normalizeName("One\\tTwo\\nThree"), "one-two-three");
});
`);

const seedPath = path.join(workspace, "facts", "workflow-seed.txt");
const derivedPath = path.join(workspace, "derived.txt");
const seedTask = `[BENCH:ADV:SCOUT] Read ${seedPath}. Return exactly BENCH_ADV_SEED=19 and nothing else.`;
const workflowScript = [
  `const seed = await runs.run("seed", { agent: "scout", task: ${JSON.stringify(seedTask)} });`,
  `if (!seed.ok) throw new Error("BENCH advanced seed child failed");`,
  `const match = String(seed.output ?? "").match(/BENCH_ADV_SEED=(\\d+)/);`,
  `if (!match) throw new Error("BENCH_ADV_SEED marker missing");`,
  `const value = Number(match[1]);`,
  `const target = value * 2;`,
  `return await runs.run("write", { agent: "worker", task: "[BENCH:ADV:WORKER] Write exactly " + target + "\\n to " + ${JSON.stringify(derivedPath)} + ". Then return exactly BENCH_ADV_WRITE=done and nothing else." });`,
].join("\n");
const workflowScriptPath = path.join(runDir, "workflow-script.txt");
write(workflowScriptPath, `${workflowScript}\n`);
const workflowScriptSha256 = crypto.createHash("sha256").update(workflowScript).digest("hex");

const minimalSchemaBytes = bytes(BasicSubagentParams);
const fullSchema = createSubagentParamsSchema();
const fullSchemaBytes = bytes(fullSchema);
const minimalSchemaText = JSON.stringify(BasicSubagentParams);
const staticChecks = {
  minimalSchemaBounded: minimalSchemaBytes < 3500,
  minimalRatioBounded: minimalSchemaBytes * 4 < fullSchemaBytes,
  callsAvailable: minimalSchemaText.includes('"calls"'),
  advancedFieldsAbsent:
    !minimalSchemaText.includes('"workflowScript"')
    && !minimalSchemaText.includes('"mission"')
    && !minimalSchemaText.includes('"schedule"')
    && !minimalSchemaText.includes('"acceptance"')
    && !minimalSchemaText.includes('"watchdog"'),
  guidanceBounded:
    Buffer.byteLength(BASIC_SUBAGENT_TOOL_DESCRIPTION) < 500
    && bytes(SubagentCapabilityParams) < 600
    && Buffer.byteLength(SUBAGENT_CAPABILITY_DESCRIPTION) < 120,
};
const staticMetrics = {
  source: "shipped-production-contracts",
  minimalSchemaBytes,
  fullSchemaBytes,
  minimalToFullRatio: Number((minimalSchemaBytes / fullSchemaBytes).toFixed(6)),
  minimalFieldCount: Object.keys(BasicSubagentParams.properties ?? {}).length,
  fullFieldCount: Object.keys(fullSchema.properties ?? {}).length,
  minimalDescriptionBytes: Buffer.byteLength(BASIC_SUBAGENT_TOOL_DESCRIPTION),
  minimalPromptSnippetBytes: Buffer.byteLength(BASIC_SUBAGENT_PROMPT_SNIPPET),
  capabilitySchemaBytes: bytes(SubagentCapabilityParams),
  capabilityDescriptionBytes: Buffer.byteLength(SUBAGENT_CAPABILITY_DESCRIPTION),
  checks: staticChecks,
  thresholds: { minimalSchemaBytesMaxExclusive: 3500, minimalToFullRatioMaxExclusive: 0.25 },
  pass: Object.values(staticChecks).every(Boolean),
};
write(path.join(runDir, "static.json"), `${JSON.stringify(staticMetrics, null, 2)}\n`);

const now = Date.now();
const meta = {
  benchmark: config.name,
  benchmarkVersion: config.version,
  runId,
  startedAt: new Date(now).toISOString(),
  startedAtMs: now,
  packageRoot: repoRoot,
  packageVersion: pkg.version,
  commit,
  branch: run("git", ["branch", "--show-current"]),
  repoDirty,
  repoStatus: gitStatus === "unknown" ? [] : gitStatus.split(/\r?\n/).filter(Boolean).slice(0, 100),
  repoDiffStat: gitDiffStat === "unknown" ? "unavailable" : gitDiffStat.slice(0, 8000),
  piVersion: run("pi", ["--version"]),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  hostname: os.hostname(),
  runDir,
  workspace,
  workflowScriptPath,
  workflowScriptSha256,
};
write(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  runId,
  runDir,
  workspace,
  workflowScriptPath,
  workflowScriptSha256,
  packageVersion: pkg.version,
  commit,
  benchmarkVersion: config.version,
  staticPass: staticMetrics.pass,
  repoDirty,
}, null, 2)}\n`);
