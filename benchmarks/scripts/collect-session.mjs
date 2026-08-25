#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runId = process.argv[2];
if (!runId) throw new Error("Usage: collect-session.mjs <runId>");
const here = path.dirname(fileURLToPath(import.meta.url));
const benchmarkDir = path.resolve(here, "..");
const config = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "benchmark.json"), "utf8"));
const resultsRoot = config.resultsRoot.startsWith("~/") ? path.join(os.homedir(), config.resultsRoot.slice(2)) : config.resultsRoot;
const runDir = path.join(resultsRoot, "runs", runId);
const metaPath = path.join(runDir, "meta.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
meta.coreEndedAt = new Date().toISOString();
meta.coreEndedAtMs = Date.now();
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
}
function usageZero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}
function normalizedUsage(usage) {
  const out = usageZero();
  if (!usage || typeof usage !== "object") return out;
  out.input = Number(usage.input ?? usage.inputTokens ?? 0);
  out.output = Number(usage.output ?? usage.outputTokens ?? 0);
  out.cacheRead = Number(usage.cacheRead ?? 0);
  out.cacheWrite = Number(usage.cacheWrite ?? 0);
  out.totalTokens = Number(usage.totalTokens ?? (out.input + out.output + out.cacheRead + out.cacheWrite));
  return out;
}
function addUsage(target, usage) {
  const value = normalizedUsage(usage);
  for (const key of Object.keys(target)) target[key] += value[key];
}
function collectJsonlPaths(value, out = new Set()) {
  if (typeof value === "string") {
    if (value.toLowerCase().endsWith(".jsonl") && fs.existsSync(value)) out.add(path.resolve(value));
    if (value.toLowerCase().endsWith(".json") && fs.existsSync(value)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(value, "utf8"));
        if (Array.isArray(parsed?.entries)) {
          for (const entry of parsed.entries) {
            if (entry?.source === "session" && typeof entry.path === "string" && fs.existsSync(entry.path)) out.add(path.resolve(entry.path));
          }
        }
      } catch {}
    }
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonlPaths(item, out);
    return out;
  }
  for (const item of Object.values(value)) collectJsonlPaths(item, out);
  return out;
}
function usageFromJsonl(file) {
  const total = usageZero();
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === "message" && record?.message?.role === "assistant") addUsage(total, record.message.usage);
      else if (record?.role === "assistant" && record?.usage) addUsage(total, record.usage);
    }
  } catch {}
  return total;
}
function sameStrings(a, b) {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}
function sameMinimalSurface(surface, initial) {
  if (!surface || !initial) return false;
  return !surface.subagentWaitActive
    && sameStrings(surface.piSubagentsActiveToolNames, initial.piSubagentsActiveToolNames)
    && surface.piSubagentsModelFacingToolDefinitionBytes === initial.piSubagentsModelFacingToolDefinitionBytes
    && surface.piSubagentsModelFacingBytesByTool?.subagent === initial.piSubagentsModelFacingBytesByTool?.subagent
    && surface.piSubagentsModelFacingBytesByTool?.subagent_capability === initial.piSubagentsModelFacingBytesByTool?.subagent_capability;
}
function successfulForegroundCall(message, expectedResults) {
  if (!message || message.isError === true) return false;
  const results = message.details?.results;
  return Array.isArray(results)
    && results.length === expectedResults
    && results.every((result) => result && result.exitCode === 0 && !result.error && !result.timedOut && !result.stopped);
}
function successfulWaitCompletion(message) {
  if (!message || message.isError === true) return false;
  const completions = message.details?.completions;
  if (!Array.isArray(completions) || completions.length === 0) return false;
  return completions.some((completion) => {
    if (completion?.success === true || completion?.state === "complete" || completion?.state === "completed") return true;
    if (!Array.isArray(completion?.results) || completion.results.length === 0) return false;
    return completion.results.every((result) => result?.success !== false && !result?.error);
  });
}

const sessionRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
const candidates = [];
for (const file of walk(sessionRoot)) {
  const stat = fs.statSync(file);
  if (stat.mtimeMs < meta.startedAtMs - 5 * 60_000) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("BENCH_SUBAGENT_V3") && text.includes(runId)) candidates.push(file);
}
if (candidates.length !== 1) throw new Error(`Expected exactly one parent benchmark session, found ${candidates.length}: ${candidates.join(", ")}`);

const sessionPath = path.resolve(candidates[0]);
const entries = fs.readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
let probeUserIndex = -1;
let benchmarkUserIndex = -1;
let cleanContext = null;
const surfaceSnapshots = [];
for (let i = 0; i < entries.length; i += 1) {
  const entry = entries[i];
  if (entry.type === "message" && entry.message?.role === "user") {
    const text = messageText(entry.message);
    if (text.includes("BENCH_SUBAGENT_PROBE_V3")) probeUserIndex = i;
    if (text.includes("BENCH_SUBAGENT_V3")) benchmarkUserIndex = i;
  }
  if (entry.type === "custom" && entry.customType === "pi-subagents-benchmark" && entry.data?.version === 3) {
    if (entry.data.cleanContext) cleanContext = entry.data.cleanContext;
    if (entry.data.phase === "surface" && entry.data.surface) surfaceSnapshots.push(entry.data.surface);
  }
}
if (probeUserIndex < 0 || benchmarkUserIndex < 0) throw new Error("Benchmark probe/spec markers are missing from the parent session.");

const assistantEntries = [];
const toolCalls = [];
const toolResults = new Map();
const parentUsage = usageZero();
for (let i = 0; i < entries.length; i += 1) {
  const entry = entries[i];
  if (entry.type !== "message") continue;
  const message = entry.message;
  if (message?.role === "assistant") {
    assistantEntries.push({ index: i, entry });
    if (i > benchmarkUserIndex) addUsage(parentUsage, message.usage);
    if (i > benchmarkUserIndex) {
      for (const part of message.content ?? []) {
        if (part?.type === "toolCall") toolCalls.push({ index: i, id: part.id, name: part.name, args: part.arguments ?? {} });
      }
    }
  }
  if (message?.role === "toolResult") toolResults.set(message.toolCallId, message);
}

const probeAssistant = assistantEntries.find((item) => item.index > probeUserIndex && item.index < benchmarkUserIndex)?.entry?.message;
if (!probeAssistant) throw new Error("Could not find clean probe assistant response.");
const cleanProbeText = messageText(probeAssistant).trim();
const cleanProbeUsage = normalizedUsage(probeAssistant.usage);

const callText = (call) => JSON.stringify(call.args ?? {});
const resultMessage = (call) => toolResults.get(call?.id);
const findCall = (predicate) => toolCalls.find(predicate);
const findCalls = (predicate) => toolCalls.filter(predicate);
const markerCall = (marker) => findCall((call) => call.name === "subagent" && callText(call).includes(marker));

const single = markerCall("[BENCH:SINGLE]");
const parallel = markerCall("[BENCH:PARALLEL:A]");
const advanced = markerCall("[BENCH:ADVANCED]");
const asyncCall = markerCall("[BENCH:ASYNC]");
const waitCall = findCall((call) => call.name === "subagent_wait");
const capabilityCalls = findCalls((call) => call.name === "subagent_capability");
const capabilitySequence = capabilityCalls.map((call) => call.args?.mode).filter(Boolean);
const expectedCapabilitySequence = ["advanced", "minimal", "wait", "minimal"];
const capabilityDiscipline = JSON.stringify(capabilitySequence) === JSON.stringify(expectedCapabilitySequence);
const subagentCalls = findCalls((call) => call.name === "subagent");
const expectedCoreSubagentCalls = Number(meta.expectedCoreSubagentCalls ?? config.expectedCoreSubagentCalls ?? 4);
const extraSubagentCalls = Math.max(0, subagentCalls.length - expectedCoreSubagentCalls);
const disciplinePass = capabilityDiscipline && subagentCalls.length === expectedCoreSubagentCalls && findCalls((call) => call.name === "subagent_wait").length === 1;

const initialSurface = cleanContext?.surface ?? null;
const [advancedSurface, restoredSurface, waitSurface, finalSurface] = surfaceSnapshots;
const advancedSurfacePass = Boolean(
  advancedSurface
  && !advancedSurface.subagentWaitActive
  && advancedSurface.piSubagentsActiveToolNames?.includes("subagent")
  && advancedSurface.piSubagentsActiveToolNames?.includes("subagent_capability")
  && !advancedSurface.piSubagentsActiveToolNames?.includes("subagent_wait")
  && Number(advancedSurface.piSubagentsModelFacingBytesByTool?.subagent ?? 0) > Number(initialSurface?.piSubagentsModelFacingBytesByTool?.subagent ?? Infinity)
);
const restoredSurfacePass = sameMinimalSurface(restoredSurface, initialSurface);
const waitSurfacePass = Boolean(
  waitSurface
  && waitSurface.subagentWaitActive
  && waitSurface.piSubagentsActiveToolNames?.includes("subagent_wait")
  && waitSurface.piSubagentsModelFacingBytesByTool?.subagent === initialSurface?.piSubagentsModelFacingBytesByTool?.subagent
);
const finalMinimalPass = sameMinimalSurface(finalSurface, initialSurface);

const staticMetrics = JSON.parse(fs.readFileSync(path.join(runDir, "static.json"), "utf8"));
const expectedWorkflowScript = String(meta.workflowScript ?? "").trim();
const scenarios = {
  cleanProbe: Boolean(probeAssistant),
  staticSurface: Boolean(staticMetrics.pass && initialSurface && !initialSurface.subagentWaitActive),
  single: Boolean(single && single.args.async === false && !single.args.workflowScript && !single.args.calls && successfulForegroundCall(resultMessage(single), 1)),
  parallel: Boolean(parallel && parallel.args.async === false && Array.isArray(parallel.args.calls) && parallel.args.calls.length === 2 && successfulForegroundCall(resultMessage(parallel), 2)),
  advancedRun: Boolean(advanced && advanced.args.async === false && advanced.args.workflowScript?.trim() === expectedWorkflowScript && successfulForegroundCall(resultMessage(advanced), 1) && advancedSurfacePass),
  advancedRestore: restoredSurfacePass,
  asyncWait: Boolean(asyncCall && asyncCall.args.async === true && waitCall && successfulWaitCompletion(resultMessage(waitCall)) && waitSurfacePass),
  finalMinimal: finalMinimalPass,
};

const syncNestedUsage = usageZero();
let syncUsageSources = 0;
for (const call of subagentCalls.filter((candidate) => candidate.args?.async !== true)) {
  const details = resultMessage(call)?.details;
  if (details?.totalChildUsage) {
    addUsage(syncNestedUsage, details.totalChildUsage);
    syncUsageSources += 1;
  } else if (Array.isArray(details?.results)) {
    for (const child of details.results) {
      if (child?.usage) {
        addUsage(syncNestedUsage, child.usage);
        syncUsageSources += 1;
      }
    }
  }
}
const asyncJsonlPaths = new Set();
collectJsonlPaths(resultMessage(waitCall)?.details, asyncJsonlPaths);
asyncJsonlPaths.delete(sessionPath);
const asyncNestedUsage = usageZero();
for (const file of asyncJsonlPaths) addUsage(asyncNestedUsage, usageFromJsonl(file));
const nestedSubagentUsage = usageZero();
addUsage(nestedSubagentUsage, syncNestedUsage);
addUsage(nestedSubagentUsage, asyncNestedUsage);

const scenarioPassed = Object.values(scenarios).filter(Boolean).length;
const scenarioTotal = Object.keys(scenarios).length;
const metrics = {
  runId,
  benchmarkVersion: meta.benchmarkVersion,
  sessionPath,
  sessionBytesAtCollection: fs.statSync(sessionPath).size,
  provider: probeAssistant.provider ?? "unknown",
  model: probeAssistant.model ?? "unknown",
  cleanContext,
  cleanProbeText,
  cleanProbeUsage,
  parentUsage,
  nestedSubagentUsage,
  coreWallMs: Math.max(0, meta.coreEndedAtMs - meta.startedAtMs),
  static: staticMetrics,
  surfaces: { initial: initialSurface, advanced: advancedSurface ?? null, restored: restoredSurface ?? null, wait: waitSurface ?? null, final: finalSurface ?? null },
  toolDiscipline: {
    capabilitySequence,
    expectedCapabilitySequence,
    capabilityDiscipline,
    subagentCalls: subagentCalls.length,
    expectedCoreSubagentCalls,
    expectedChildRuns: Number(meta.expectedChildRuns ?? config.expectedChildRuns ?? 5),
    extraSubagentCalls,
    waitCalls: findCalls((call) => call.name === "subagent_wait").length,
    pass: disciplinePass,
  },
  nestedUsageEvidence: {
    syncUsageSources,
    asyncJsonlPaths: [...asyncJsonlPaths],
    syncUsage: syncNestedUsage,
    asyncUsage: asyncNestedUsage,
  },
  scenarios,
  scenarioPassed,
  scenarioTotal,
  deterministicPass: scenarioPassed === scenarioTotal && disciplinePass,
};
fs.writeFileSync(path.join(runDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
meta.sessionPath = sessionPath;
meta.provider = metrics.provider;
meta.model = metrics.model;
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  runId,
  deterministicPass: metrics.deterministicPass,
  scenarios: `${scenarioPassed}/${scenarioTotal}`,
  piSubagentsModelFacingBytes: initialSurface?.piSubagentsModelFacingToolDefinitionBytes ?? null,
  minimalSchemaBytes: staticMetrics.minimalSchemaBytes,
  fullSchemaBytes: staticMetrics.fullSchemaBytes,
  capabilitySequence,
  extraSubagentCalls,
  cleanProbeUsage,
  parentUsage,
  nestedSubagentUsage,
  coreWallMs: metrics.coreWallMs,
}, null, 2)}\n`);
