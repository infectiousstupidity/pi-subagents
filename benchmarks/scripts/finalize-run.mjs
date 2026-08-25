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

function readReview(name) {
  const file = path.join(runDir, name);
  if (!fs.existsSync(file)) return { verdict: "MISSING", text: "(missing review)" };
  const text = fs.readFileSync(file, "utf8").trim();
  const match = text.match(/^VERDICT:\s*(PASS|WARN|FAIL)\s*$/mi);
  return { verdict: match?.[1]?.toUpperCase() ?? "INVALID", text };
}
const efficiencyReview = readReview("review-efficiency.md");
const correctnessReview = readReview("review-correctness.md");

function parseSessionToolCalls(sessionPath) {
  const calls = [];
  if (!sessionPath || !fs.existsSync(sessionPath)) return calls;
  for (const line of fs.readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const part of entry.message.content ?? []) {
      if (part?.type === "toolCall") calls.push({ timestamp: Date.parse(entry.timestamp ?? 0), name: part.name, args: part.arguments ?? {} });
    }
  }
  return calls;
}

const allCalls = parseSessionToolCalls(metrics.sessionPath);
const postCoreCalls = allCalls.filter((call) => Number.isFinite(call.timestamp) && call.timestamp > meta.coreEndedAtMs + 500);
const reviewCall = postCoreCalls.find((call) => call.name === "subagent" && JSON.stringify(call.args).includes("[BENCH:REVIEW:EFFICIENCY]"));
const postCoreCapabilityLoads = postCoreCalls.filter((call) => call.name === "subagent_capability");
const postReviewCompactPass = Boolean(
  reviewCall
  && reviewCall.args.async === false
  && Array.isArray(reviewCall.args.calls)
  && reviewCall.args.calls.length === 2
  && postCoreCapabilityLoads.length === 0
);
metrics.postReviewCompactPass = postReviewCompactPass;
fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);

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
      candidates.push({ meta: otherMeta, metrics: otherMetrics });
    } catch {}
  }
  candidates.sort((a, b) => (b.meta.startedAtMs ?? 0) - (a.meta.startedAtMs ?? 0));
  return candidates[0] ?? null;
}

const previous = previousComparableRun();
const pct = (current, prior) => prior > 0 ? ((current - prior) / prior) * 100 : null;
const comparison = previous ? {
  runId: previous.meta.runId,
  minimalSchemaBytesPct: pct(metrics.static.minimalSchemaBytes, previous.metrics.static?.minimalSchemaBytes ?? 0),
  cleanProbeTotalTokensPct: pct(metrics.cleanProbeUsage.totalTokens, previous.metrics.cleanProbeUsage?.totalTokens ?? 0),
  coreParentTotalTokensPct: pct(metrics.parentUsage.totalTokens, previous.metrics.parentUsage?.totalTokens ?? 0),
  nestedSubagentTotalTokensPct: pct(metrics.nestedSubagentUsage.totalTokens, previous.metrics.nestedSubagentUsage?.totalTokens ?? 0),
  coreWallMsPct: pct(metrics.coreWallMs, previous.metrics.coreWallMs ?? 0),
} : null;

const reviewFail = efficiencyReview.verdict === "FAIL"
  || correctnessReview.verdict === "FAIL"
  || efficiencyReview.verdict === "INVALID"
  || correctnessReview.verdict === "INVALID";
const reviewWarn = efficiencyReview.verdict === "WARN" || correctnessReview.verdict === "WARN";
const disciplineWarn = !metrics.toolDiscipline.capabilityDiscipline || metrics.toolDiscipline.extraSubagentCalls > 0;
const comparableWarn = Boolean(comparison && (
  (comparison.minimalSchemaBytesPct ?? 0) > 5
  || (comparison.cleanProbeTotalTokensPct ?? 0) > 15
  || (comparison.coreParentTotalTokensPct ?? 0) > 25
  || (comparison.nestedSubagentTotalTokensPct ?? 0) > 25
  || (comparison.coreWallMsPct ?? 0) > 50
));
const hardPass = metrics.deterministicPass
  && postReviewCompactPass
  && efficiencyReview.verdict !== "MISSING"
  && correctnessReview.verdict !== "MISSING";
const overall = !hardPass || reviewFail ? "FAIL" : reviewWarn || disciplineWarn || comparableWarn ? "WARN" : "PASS";

function fmtUsage(usage) {
  return `input ${usage.input} · output ${usage.output} · cache-read ${usage.cacheRead} · cache-write ${usage.cacheWrite} · total ${usage.totalTokens}`;
}
function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
function fmtContext(value) {
  if (!value) return "unavailable";
  const usage = value.usage;
  const tokens = usage?.tokens ?? "unknown";
  const window = usage?.contextWindow ?? "unknown";
  return `${tokens}/${window} tokens · system ${value.systemPromptBytes ?? "?"} B · active tools ${value.activeToolNames?.length ?? "?"} · tool defs ${value.activeToolDefinitionBytes ?? "?"} B`;
}

const scenarioRows = Object.entries(metrics.scenarios).map(([name, pass]) => `| ${name} | ${pass ? "PASS" : "FAIL"} |`).join("\n");
const report = `# pi-subagents benchmark v2 — ${runId}\n\n`
+ `Overall: **${overall}**  \nDeterministic: **${metrics.deterministicPass && postReviewCompactPass ? "PASS" : "FAIL"}**  \nScenarios: **${metrics.scenarioPassed}/${metrics.scenarioTotal} core/probe + post-review compact ${postReviewCompactPass ? "PASS" : "FAIL"}**\n\n`
+ `## Environment\n\n| Field | Value |\n|---|---|\n| Benchmark | v${meta.benchmarkVersion} |\n| pi-subagents | ${meta.packageVersion} |\n| Commit | \`${meta.commit}\` |\n| Branch | ${meta.branch} |\n| Repo dirty | ${meta.repoDirty} |\n| Pi | ${meta.piVersion} |\n| Provider/model | ${metrics.provider}/${metrics.model} |\n| Node | ${meta.nodeVersion} |\n| Platform | ${meta.platform} |\n| Session | \`${metrics.sessionPath}\` |\n\n`
+ `## Deterministic checks\n\n| Scenario | Result |\n|---|---|\n${scenarioRows}\n| postReviewCompact | ${postReviewCompactPass ? "PASS" : "FAIL"} |\n\n`
+ `## Clean starting context\n\n- Probe: ${fmtUsage(metrics.cleanProbeUsage)}\n- Estimated clean context: ${fmtContext(metrics.cleanContext)}\n\n`
+ `## Context surface\n\n| Metric | Value |\n|---|---:|\n| Minimal schema | ${metrics.static.minimalSchemaBytes} bytes |\n| Full schema | ${metrics.static.fullSchemaBytes} bytes |\n| Minimal/full | ${(metrics.static.minimalToFullRatio * 100).toFixed(2)}% |\n| Minimal fields | ${metrics.static.minimalFieldCount} |\n| Full fields | ${metrics.static.fullFieldCount} |\n| Minimal description | ${metrics.static.minimalDescriptionBytes} bytes |\n| Capability schema | ${metrics.static.capabilitySchemaBytes} bytes |\n\n`
+ `## Measured core\n\n- Parent: ${fmtUsage(metrics.parentUsage)}\n- Nested subagents: ${fmtUsage(metrics.nestedSubagentUsage)}\n- Core wall time: ${(metrics.coreWallMs / 1000).toFixed(1)}s\n- Capability sequence: \`${metrics.toolDiscipline.capabilitySequence.join(" → ")}\`\n- Extra core subagent calls: ${metrics.toolDiscipline.extraSubagentCalls}\n- Nested usage evidence: ${metrics.nestedUsageEvidence.syncUsageSources} sync aggregate(s), ${metrics.nestedUsageEvidence.asyncJsonlPaths.length} async JSONL path(s)\n\n`
+ `## Comparable previous v2 run\n\n${comparison ? `Previous: \`${comparison.runId}\`\n\n| Metric | Delta |\n|---|---:|\n| Minimal schema bytes | ${fmtPct(comparison.minimalSchemaBytesPct)} |\n| Clean probe tokens | ${fmtPct(comparison.cleanProbeTotalTokensPct)} |\n| Core parent tokens | ${fmtPct(comparison.coreParentTotalTokensPct)} |\n| Nested subagent tokens | ${fmtPct(comparison.nestedSubagentTotalTokensPct)} |\n| Core wall time | ${fmtPct(comparison.coreWallMsPct)} |` : "No prior run with the same benchmark version, Pi version, provider, and model."}\n\n`
+ `## Independent reviews\n\n### Efficiency — ${efficiencyReview.verdict}\n\n${efficiencyReview.text}\n\n### Correctness — ${correctnessReview.verdict}\n\n${correctnessReview.text}\n`;
const reportPath = path.join(runDir, "report.md");
fs.writeFileSync(reportPath, report);

const resultsPath = path.join(resultsRoot, "RESULTS.md");
fs.mkdirSync(resultsRoot, { recursive: true });
const v2Header = `# pi-subagents benchmark results\n\nv2 separates the clean-context probe from the benchmark workload. Token/time comparisons are meaningful only between comparable v2 environments.\n\n## Benchmark v2\n\n| Date | Run | pkg | commit | Pi | model | clean probe | clean ctx | minimal/full | core parent | nested | scenarios | review E/C | wall | status | report |\n|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|\n<!-- BENCHMARK_V2_ROWS -->\n`;

if (!fs.existsSync(resultsPath)) {
  fs.writeFileSync(resultsPath, v2Header);
} else {
  let existing = fs.readFileSync(resultsPath, "utf8");
  if (!existing.includes("<!-- BENCHMARK_V2_ROWS -->")) {
    const legacy = existing.trim();
    fs.writeFileSync(resultsPath, `${v2Header}\n## Legacy benchmark results\n\n${legacy}\n`);
  }
}

let results = fs.readFileSync(resultsPath, "utf8");
if (!results.includes(`| ${runId} |`)) {
  const date = meta.startedAt.slice(0, 10);
  const cleanCtxTokens = metrics.cleanContext?.usage?.tokens ?? "n/a";
  const row = `| ${date} | ${runId} | ${meta.packageVersion} | ${String(meta.commit).slice(0, 8)} | ${meta.piVersion} | ${metrics.provider}/${metrics.model} | ${metrics.cleanProbeUsage.totalTokens} | ${cleanCtxTokens} | ${metrics.static.minimalSchemaBytes}/${metrics.static.fullSchemaBytes} (${(metrics.static.minimalToFullRatio * 100).toFixed(1)}%) | ${metrics.parentUsage.totalTokens} | ${metrics.nestedSubagentUsage.totalTokens} | ${metrics.scenarioPassed}/${metrics.scenarioTotal}+${postReviewCompactPass ? "1" : "0"} | ${efficiencyReview.verdict}/${correctnessReview.verdict} | ${(metrics.coreWallMs / 1000).toFixed(1)}s | **${overall}** | [report](runs/${runId}/report.md) |\n`;
  results = results.replace("<!-- BENCHMARK_V2_ROWS -->", `${row}<!-- BENCHMARK_V2_ROWS -->`);
  fs.writeFileSync(resultsPath, results);
}

process.stdout.write(`${JSON.stringify({
  runId,
  overall,
  deterministicPass: metrics.deterministicPass && postReviewCompactPass,
  scenarios: `${metrics.scenarioPassed}/${metrics.scenarioTotal}+post-review:${postReviewCompactPass ? "pass" : "fail"}`,
  cleanProbeUsage: metrics.cleanProbeUsage,
  cleanContext: metrics.cleanContext,
  minimalSchemaBytes: metrics.static.minimalSchemaBytes,
  fullSchemaBytes: metrics.static.fullSchemaBytes,
  minimalToFullRatio: metrics.static.minimalToFullRatio,
  coreParentTokens: metrics.parentUsage.totalTokens,
  nestedSubagentTokens: metrics.nestedSubagentUsage.totalTokens,
  coreWallMs: metrics.coreWallMs,
  capabilitySequence: metrics.toolDiscipline.capabilitySequence,
  extraSubagentCalls: metrics.toolDiscipline.extraSubagentCalls,
  efficiencyReview: efficiencyReview.verdict,
  correctnessReview: correctnessReview.verdict,
  resultsPath,
  reportPath,
}, null, 2)}\n`);
