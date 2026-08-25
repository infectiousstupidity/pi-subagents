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
const packageRoot = path.resolve(benchmarkDir, "..");
const config = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "benchmark.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (pkg.name !== "pi-subagents") throw new Error(`Expected pi-subagents package, got ${pkg.name ?? "unknown"}`);

function exec(command, args) {
  return execFileSync(command, args, { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function run(command, args) {
  try {
    return exec(command, args).trim();
  } catch {
    return "unknown";
  }
}
function runPreserveLeading(command, args) {
  try {
    return exec(command, args).replace(/[\r\n]+$/, "");
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
function statusPath(line) {
  let value = line.slice(3).trim();
  const arrow = value.lastIndexOf(" -> ");
  if (arrow >= 0) value = value.slice(arrow + 4);
  return value.replace(/^"|"$/g, "").replace(/\\/g, "/");
}
function isBenchmarkRelevantDirtyPath(file) {
  if (file === "package-lock.json" || file === "README.md" || file === "CHANGELOG.md" || file === ".gitignore") return false;
  if (file.startsWith("docs/") || file.startsWith("test/")) return false;
  return true;
}

const commit = run("git", ["rev-parse", "HEAD"]);
const shortCommit = commit === "unknown" ? "unknown" : commit.slice(0, 8);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runId = `${stamp}-${shortCommit}-${crypto.randomBytes(2).toString("hex")}`;
const resultsRoot = expandHome(config.resultsRoot);
const runDir = path.join(resultsRoot, "runs", runId);
fs.mkdirSync(path.dirname(runDir), { recursive: true });
fs.mkdirSync(runDir, { recursive: false });

const advancedTask = "[BENCH:ADVANCED] Return exactly BENCH_ADVANCED=ok and nothing else.";
const workflowScript = [
  `const result = await runs.run("advanced", { agent: "scout", task: ${JSON.stringify(advancedTask)} });`,
  `return result.output;`,
].join("\n");
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

const repoStatus = runPreserveLeading("git", ["status", "--porcelain=v1"]);
const repoStatusLines = repoStatus && repoStatus !== "unknown" ? repoStatus.split(/\r?\n/).filter(Boolean) : [];
const repoRelevantStatus = repoStatusLines.filter((line) => isBenchmarkRelevantDirtyPath(statusPath(line)));
const repoDiffStat = run("git", ["diff", "--stat"]);
const now = Date.now();
const meta = {
  benchmark: config.name,
  benchmarkVersion: config.version,
  runId,
  startedAt: new Date(now).toISOString(),
  startedAtMs: now,
  packageRoot,
  packageVersion: pkg.version,
  commit,
  branch: run("git", ["branch", "--show-current"]),
  repoDirty: repoStatusLines.length > 0,
  repoRelevantDirty: repoRelevantStatus.length > 0,
  repoStatus: repoStatusLines,
  repoRelevantStatus,
  repoDiffStat: repoDiffStat === "unknown" ? "" : repoDiffStat,
  piVersion: run("pi", ["--version"]),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  hostname: os.hostname(),
  runDir,
  workflowScript,
  workflowScriptSha256,
  expectedCoreSubagentCalls: config.expectedCoreSubagentCalls,
  expectedChildRuns: config.expectedChildRuns,
};
write(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  runId,
  runDir,
  workflowScript,
  workflowScriptSha256,
  packageVersion: pkg.version,
  commit,
  benchmarkVersion: config.version,
  staticPass: staticMetrics.pass,
  expectedCoreSubagentCalls: config.expectedCoreSubagentCalls,
  expectedChildRuns: config.expectedChildRuns,
  repoRelevantDirty: meta.repoRelevantDirty,
}, null, 2)}\n`);
