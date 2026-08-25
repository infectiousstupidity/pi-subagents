#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runId = process.argv[2];
if (!runId) throw new Error("Usage: finalize-run.mjs <runId>");
const here = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(here, "..");
const config = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "benchmark.json"), "utf8"));
const resultsRoot = config.resultsRoot.startsWith("~/") ? path.join(os.homedir(), config.resultsRoot.slice(2)) : config.resultsRoot;
const runDir = path.join(resultsRoot, "runs", runId);
const metaPath = path.join(runDir, "meta.json");
const metricsPath = path.join(runDir, "metrics.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));

function cleanPromptTokensFor(value) {
  if (Number.isFinite(Number(value?.cleanPromptTokens))) return Number(value.cleanPromptTokens);
  const usage = value?.cleanProbeUsage ?? {};
  return Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
}

function previousComparableRun() {
  const runsRoot = path.join(resultsRoot, "runs");
  if (!fs.existsSync(runsRoot)) return null;
  const candidates = [];
  for (const name of fs.readdirSync(runsRoot)) {
    if (name === runId) continue;
    const otherMetaPath = path.join(runsRoot, name, "meta.json");
    const otherMetricsPath = path.join(runsRoot, name, "metrics.json");
    if (!fs.existsSync(otherMetaPath) || !fs.existsSync(otherMetricsPath)) continue;
    try {
      const otherMeta = JSON.parse(fs.readFileSync(otherMetaPath, "utf8"));
      const otherMetrics = JSON.parse(fs.readFileSync(otherMetricsPath, "utf8"));
      if (otherMeta.benchmarkVersion !== meta.benchmarkVersion) continue;
      if (otherMeta.piVersion !== meta.piVersion) continue;
      if (otherMetrics.provider !== metrics.provider || otherMetrics.model !== metrics.model) continue;
      if (otherMetrics.overall !== "PASS" || otherMeta.repoRelevantDirty) continue;
      candidates.push({ meta: otherMeta, metrics: otherMetrics });
    } catch {}
  }
  candidates.sort((a, b) => (b.meta.startedAtMs ?? 0) - (a.meta.startedAtMs ?? 0));
  return candidates[0] ?? null;
}

const previous = previousComparableRun();
const pct = (current, prior) => prior > 0 ? ((current - prior) / prior) * 100 : null;
const initialBytes = Number(metrics.cleanContext?.surface?.piSubagentsModelFacingToolDefinitionBytes ?? 0);
const cleanPromptTokens = cleanPromptTokensFor(metrics);
const comparison = previous ? {
  runId: previous.meta.runId,
  minimalSchemaBytesPct: pct(metrics.static.minimalSchemaBytes, previous.metrics.static?.minimalSchemaBytes ?? 0),
  piSubagentsModelFacingBytesPct: pct(initialBytes, previous.metrics.cleanContext?.surface?.piSubagentsModelFacingToolDefinitionBytes ?? 0),
  cleanPromptTokensPct: pct(cleanPromptTokens, cleanPromptTokensFor(previous.metrics)),
  coreParentTotalTokensPct: pct(metrics.parentUsage.totalTokens, previous.metrics.parentUsage?.totalTokens ?? 0),
  nestedSubagentTotalTokensPct: pct(metrics.nestedSubagentUsage.totalTokens, previous.metrics.nestedSubagentUsage?.totalTokens ?? 0),
  coreWallMsPct: pct(metrics.coreWallMs, previous.metrics.coreWallMs ?? 0),
} : null;

const contextRegressionWarn = Boolean(comparison && (
  (comparison.minimalSchemaBytesPct ?? 0) > 5
  || (comparison.piSubagentsModelFacingBytesPct ?? 0) > 5
));
const overall = !metrics.deterministicPass
  ? "FAIL"
  : meta.repoRelevantDirty || contextRegressionWarn
    ? "WARN"
    : "PASS";
metrics.overall = overall;
metrics.contextRegressionWarn = contextRegressionWarn;
fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);

function fmtUsage(usage) {
  return `input ${usage.input} · output ${usage.output} · cache-read ${usage.cacheRead} · cache-write ${usage.cacheWrite} · total ${usage.totalTokens}`;
}
function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
function fenced(lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines ?? "");
  return text.trim() ? `\n\`\`\`text\n${text.trim()}\n\`\`\`\n` : "\n(none)\n";
}

const scenarioRows = Object.entries(metrics.scenarios).map(([name, pass]) => `| ${name} | ${pass ? "PASS" : "FAIL"} |`).join("\n");
const surface = metrics.cleanContext?.surface ?? {};
const byTool = surface.piSubagentsModelFacingBytesByTool ?? {};
const dirtySection = meta.repoRelevantDirty
  ? `\n## Relevant dirty-worktree warning\n\nThis run is not a clean baseline. Relevant status:${fenced(meta.repoRelevantStatus)}\nFull diff stat:${fenced(meta.repoDiffStat)}\n`
  : meta.repoDirty
    ? `\nNon-runtime dirty files were present and intentionally ignored for baseline status:${fenced(meta.repoStatus)}\n`
    : "";

const report = `# pi-subagents benchmark v${meta.benchmarkVersion} — ${runId}\n\n`
+ `Status: **${overall}**  \nScenarios: **${metrics.scenarioPassed}/${metrics.scenarioTotal}**  \nDiscipline: **${metrics.toolDiscipline.pass ? "PASS" : "FAIL"}**\n\n`
+ `## Context tax\n\n| Metric | Value |\n|---|---:|\n| Clean prompt | ${cleanPromptTokens} tokens |\n| Probe output | ${metrics.cleanProbeUsage.output} tokens |\n| Probe tool-free | ${metrics.cleanProbe?.toolFree ? "yes" : "NO"} |\n| System prompt | ${metrics.cleanContext?.systemPromptBytes ?? "n/a"} bytes |\n| All active model-facing tool defs | ${surface.activeModelFacingToolDefinitionBytes ?? "n/a"} bytes |\n| pi-subagents model-facing defs | ${surface.piSubagentsModelFacingToolDefinitionBytes ?? "n/a"} bytes |\n| pi-subagents tools attributed by SourceInfo | ${surface.piSubagentsOwnershipSourceInfoCount ?? "n/a"} |\n| subagent | ${byTool.subagent ?? "n/a"} bytes |\n| subagent_capability | ${byTool.subagent_capability ?? "n/a"} bytes |\n| subagent_wait initially active | ${surface.subagentWaitActive ? "YES" : "no"} |\n| Minimal schema | ${metrics.static.minimalSchemaBytes} bytes |\n| Full schema | ${metrics.static.fullSchemaBytes} bytes |\n| Minimal/full | ${(metrics.static.minimalToFullRatio * 100).toFixed(2)}% |\n\n`
+ `## Function\n\n| Check | Result |\n|---|---|\n${scenarioRows}\n\n`
+ `## Discipline\n\n- Capability sequence: \`${metrics.toolDiscipline.capabilitySequence.join(" → ")}\`\n- Parent subagent calls: ${metrics.toolDiscipline.subagentCalls}/${metrics.toolDiscipline.expectedCoreSubagentCalls}\n- Expected child runs: ${metrics.toolDiscipline.expectedChildRuns}\n- Extra/retry subagent calls: ${metrics.toolDiscipline.extraSubagentCalls}\n- Wait calls: ${metrics.toolDiscipline.waitCalls}\n\n`
+ `## Informational usage\n\n- Parent: ${fmtUsage(metrics.parentUsage)}\n- Nested subagents: ${fmtUsage(metrics.nestedSubagentUsage)}\n- Core wall time: ${(metrics.coreWallMs / 1000).toFixed(1)}s\n\n`
+ `## Comparable previous v${meta.benchmarkVersion} PASS\n\n${comparison ? `Previous: \`${comparison.runId}\`\n\n| Metric | Delta | Affects status |\n|---|---:|---|\n| Minimal schema bytes | ${fmtPct(comparison.minimalSchemaBytesPct)} | yes, >5% warns |\n| pi-subagents model-facing defs | ${fmtPct(comparison.piSubagentsModelFacingBytesPct)} | yes, >5% warns |\n| Clean prompt tokens | ${fmtPct(comparison.cleanPromptTokensPct)} | no |\n| Core parent tokens | ${fmtPct(comparison.coreParentTotalTokensPct)} | no |\n| Nested subagent tokens | ${fmtPct(comparison.nestedSubagentTotalTokensPct)} | no |\n| Core wall time | ${fmtPct(comparison.coreWallMsPct)} | no |` : "No prior clean PASS with the same benchmark version, Pi version, provider, and model."}\n`
+ dirtySection;
const reportPath = path.join(runDir, "report.md");
fs.writeFileSync(reportPath, report);

const resultsPath = path.join(resultsRoot, "RESULTS.md");
fs.mkdirSync(resultsRoot, { recursive: true });
const v4Header = `# pi-subagents benchmark results\n\nv4 keeps the v3 workload but corrects clean-prompt accounting, probe contamination checks, dirty-worktree parsing, and package tool attribution. Parent/child token usage and wall time are informational only.\n\n## Benchmark v4\n\n| Date | Run | pkg | commit | Pi | model | clean prompt | pi-subagents defs | minimal/full | function | parent | nested | wall | relevant dirty | status | report |\n|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|\n<!-- BENCHMARK_V4_ROWS -->\n`;

if (!fs.existsSync(resultsPath)) {
  fs.writeFileSync(resultsPath, v4Header);
} else {
  const existing = fs.readFileSync(resultsPath, "utf8");
  if (!existing.includes("<!-- BENCHMARK_V4_ROWS -->")) {
    fs.writeFileSync(resultsPath, `${v4Header}\n## Legacy benchmark results\n\n${existing.trim()}\n`);
  }
}

let results = fs.readFileSync(resultsPath, "utf8");
if (!results.includes(`| ${runId} |`)) {
  const date = meta.startedAt.slice(0, 10);
  const row = `| ${date} | ${runId} | ${meta.packageVersion} | ${String(meta.commit).slice(0, 8)} | ${meta.piVersion} | ${metrics.provider}/${metrics.model} | ${cleanPromptTokens} | ${initialBytes} | ${metrics.static.minimalSchemaBytes}/${metrics.static.fullSchemaBytes} (${(metrics.static.minimalToFullRatio * 100).toFixed(1)}%) | ${metrics.scenarioPassed}/${metrics.scenarioTotal} | ${metrics.parentUsage.totalTokens} | ${metrics.nestedSubagentUsage.totalTokens} | ${(metrics.coreWallMs / 1000).toFixed(1)}s | ${meta.repoRelevantDirty ? "yes" : "no"} | **${overall}** | [report](runs/${runId}/report.md) |\n`;
  results = results.replace("<!-- BENCHMARK_V4_ROWS -->", `${row}<!-- BENCHMARK_V4_ROWS -->`);
  fs.writeFileSync(resultsPath, results);
}

process.stdout.write(`${JSON.stringify({
  runId,
  overall,
  scenarios: `${metrics.scenarioPassed}/${metrics.scenarioTotal}`,
  cleanPromptTokens,
  cleanProbeOutputTokens: metrics.cleanProbeUsage.output,
  cleanProbeToolFree: Boolean(metrics.cleanProbe?.toolFree),
  piSubagentsModelFacingToolDefinitionBytes: initialBytes,
  minimalSchemaBytes: metrics.static.minimalSchemaBytes,
  fullSchemaBytes: metrics.static.fullSchemaBytes,
  minimalToFullRatio: metrics.static.minimalToFullRatio,
  capabilitySequence: metrics.toolDiscipline.capabilitySequence,
  extraSubagentCalls: metrics.toolDiscipline.extraSubagentCalls,
  parentTokens: metrics.parentUsage.totalTokens,
  nestedSubagentTokens: metrics.nestedSubagentUsage.totalTokens,
  coreWallMs: metrics.coreWallMs,
  repoRelevantDirty: Boolean(meta.repoRelevantDirty),
  resultsPath,
  reportPath,
}, null, 2)}\n`);
