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
const postReviewCompactPass = Boolean(reviewCall && Array.isArray(reviewCall.args.calls) && reviewCall.args.calls.length === 2 && postCoreCapabilityLoads.length === 0);
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
      const m = JSON.parse(fs.readFileSync(otherMetaPath, "utf8"));
      const x = JSON.parse(fs.readFileSync(otherMetricsPath, "utf8"));
      if (m.benchmarkVersion !== meta.benchmarkVersion) continue;
      if (m.piVersion !== meta.piVersion) continue;
      if (x.provider !== metrics.provider || x.model !== metrics.model) continue;
      candidates.push({ meta: m, metrics: x });
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
  firstTurnTotalTokensPct: pct(metrics.firstTurnUsage.totalTokens, previous.metrics.firstTurnUsage?.totalTokens ?? 0),
  coreParentTotalTokensPct: pct(metrics.parentUsage.totalTokens, previous.metrics.parentUsage?.totalTokens ?? 0),
  coreWallMsPct: pct(metrics.coreWallMs, previous.metrics.coreWallMs ?? 0),
} : null;

const hardPass = metrics.deterministicPass && postReviewCompactPass && efficiencyReview.verdict !== "MISSING" && correctnessReview.verdict !== "MISSING";
const reviewFail = efficiencyReview.verdict === "FAIL" || correctnessReview.verdict === "FAIL" || efficiencyReview.verdict === "INVALID" || correctnessReview.verdict === "INVALID";
const reviewWarn = efficiencyReview.verdict === "WARN" || correctnessReview.verdict === "WARN";
const comparableWarn = Boolean(comparison && (
  (comparison.minimalSchemaBytesPct ?? 0) > 5 ||
  (comparison.firstTurnTotalTokensPct ?? 0) > 15 ||
  (comparison.coreParentTotalTokensPct ?? 0) > 25 ||
  (comparison.coreWallMsPct ?? 0) > 50
));
const overall = !hardPass || reviewFail ? "FAIL" : reviewWarn || comparableWarn ? "WARN" : "PASS";

function fmtUsage(usage) {
  return `input ${usage.input} · output ${usage.output} · cache-read ${usage.cacheRead} · cache-write ${usage.cacheWrite} · total ${usage.totalTokens}`;
}
function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
const scenarioRows = Object.entries(metrics.scenarios).map(([name, pass]) => `| ${name} | ${pass ? "PASS" : "FAIL"} |`).join("\n");
const report = `# pi-subagents benchmark — ${runId}\n\n` +
`Overall: **${overall}**  \nDeterministic: **${metrics.deterministicPass && postReviewCompactPass ? "PASS" : "FAIL"}**  \nScenarios: **${metrics.scenarioPassed}/${metrics.scenarioTotal} core + post-review compact ${postReviewCompactPass ? "PASS" : "FAIL"}**\n\n` +
`## Environment\n\n| Field | Value |\n|---|---|\n| Benchmark | v${meta.benchmarkVersion} |\n| pi-subagents | ${meta.packageVersion} |\n| Commit | \`${meta.commit}\` |\n| Branch | ${meta.branch} |\n| Repo dirty | ${meta.repoDirty} |\n| Pi | ${meta.piVersion} |\n| Provider/model | ${metrics.provider}/${metrics.model} |\n| Node | ${meta.nodeVersion} |\n| Platform | ${meta.platform} |\n| Session | \`${metrics.sessionPath}\` |\n\n` +
`## Deterministic checks\n\n| Scenario | Result |\n|---|---|\n${scenarioRows}\n| postReviewCompact | ${postReviewCompactPass ? "PASS" : "FAIL"} |\n\n` +
`## Context surface\n\n| Metric | Value |\n|---|---:|\n| Minimal schema | ${metrics.static.minimalSchemaBytes} bytes |\n| Full schema | ${metrics.static.fullSchemaBytes} bytes |\n| Minimal/full | ${(metrics.static.minimalToFullRatio * 100).toFixed(2)}% |\n| Minimal fields | ${metrics.static.minimalFieldCount} |\n| Full fields | ${metrics.static.fullFieldCount} |\n| Minimal description | ${metrics.static.minimalDescriptionBytes} bytes |\n| Capability schema | ${metrics.static.capabilitySchemaBytes} bytes |\n\n` +
`## Usage\n\n- First turn: ${fmtUsage(metrics.firstTurnUsage)}\n- Core parent: ${fmtUsage(metrics.parentUsage)}\n- Nested tool/subagent: ${fmtUsage(metrics.nestedToolUsage)}\n- Core wall time: ${(metrics.coreWallMs / 1000).toFixed(1)}s\n- Capability sequence: \`${metrics.toolDiscipline.capabilitySequence.join(" → ")}\`\n\n` +
`## Comparable previous run\n\n${comparison ? `Previous: \`${comparison.runId}\`\n\n| Metric | Delta |\n|---|---:|\n| Minimal schema bytes | ${fmtPct(comparison.minimalSchemaBytesPct)} |\n| First-turn total tokens | ${fmtPct(comparison.firstTurnTotalTokensPct)} |\n| Core parent total tokens | ${fmtPct(comparison.coreParentTotalTokensPct)} |\n| Core wall time | ${fmtPct(comparison.coreWallMsPct)} |` : "No prior run with the same benchmark version, Pi version, provider, and model."}\n\n` +
`## Independent reviews\n\n### Efficiency — ${efficiencyReview.verdict}\n\n${efficiencyReview.text}\n\n### Correctness — ${correctnessReview.verdict}\n\n${correctnessReview.text}\n`;
const reportPath = path.join(runDir, "report.md");
fs.writeFileSync(reportPath, report);

const resultsPath = path.join(resultsRoot, "RESULTS.md");
fs.mkdirSync(resultsRoot, { recursive: true });
if (!fs.existsSync(resultsPath)) {
  fs.writeFileSync(resultsPath, `# pi-subagents benchmark results\n\nGenerated by \`/bench-subagent\`. Token/time comparisons are meaningful only between comparable environments.\n\n| Date | Run | pkg | commit | Pi | model | first-turn tokens | minimal/full | core parent | nested | scenarios | review E/C | wall | status | report |\n|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|---:|---|---|\n`);
}
let results = fs.readFileSync(resultsPath, "utf8");
if (!results.includes(`| ${runId} |`)) {
  const date = meta.startedAt.slice(0, 10);
  const row = `| ${date} | ${runId} | ${meta.packageVersion} | ${String(meta.commit).slice(0, 8)} | ${meta.piVersion} | ${metrics.provider}/${metrics.model} | ${metrics.firstTurnUsage.totalTokens} | ${metrics.static.minimalSchemaBytes}/${metrics.static.fullSchemaBytes} (${(metrics.static.minimalToFullRatio * 100).toFixed(1)}%) | ${metrics.parentUsage.totalTokens} | ${metrics.nestedToolUsage.totalTokens} | ${metrics.scenarioPassed}/${metrics.scenarioTotal}+${postReviewCompactPass ? "1" : "0"} | ${efficiencyReview.verdict}/${correctnessReview.verdict} | ${(metrics.coreWallMs / 1000).toFixed(1)}s | **${overall}** | [report](runs/${runId}/report.md) |\n`;
  results += row;
  fs.writeFileSync(resultsPath, results);
}

process.stdout.write(`${JSON.stringify({
  runId,
  overall,
  deterministicPass: metrics.deterministicPass && postReviewCompactPass,
  scenarios: `${metrics.scenarioPassed}/${metrics.scenarioTotal}+post-review:${postReviewCompactPass ? "pass" : "fail"}`,
  firstTurnUsage: metrics.firstTurnUsage,
  minimalSchemaBytes: metrics.static.minimalSchemaBytes,
  fullSchemaBytes: metrics.static.fullSchemaBytes,
  minimalToFullRatio: metrics.static.minimalToFullRatio,
  coreParentTokens: metrics.parentUsage.totalTokens,
  nestedSubagentTokens: metrics.nestedToolUsage.totalTokens,
  coreWallMs: metrics.coreWallMs,
  efficiencyReview: efficiencyReview.verdict,
  correctnessReview: correctnessReview.verdict,
  resultsPath,
  reportPath,
}, null, 2)}\n`);
