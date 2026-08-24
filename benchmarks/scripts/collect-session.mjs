#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const sessionRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
const candidates = [];
for (const file of walk(sessionRoot)) {
  const stat = fs.statSync(file);
  if (stat.mtimeMs < meta.startedAtMs - 60_000) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("BENCH_SUBAGENT_V1") && text.includes(runId)) candidates.push(file);
}
if (candidates.length !== 1) {
  throw new Error(`Expected exactly one parent benchmark session, found ${candidates.length}: ${candidates.join(", ")}`);
}
const sessionPath = candidates[0];
const entries = fs.readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const coreEntries = entries.filter((entry) => {
  const ms = Date.parse(entry.timestamp ?? entry.message?.timestamp ?? 0);
  return !Number.isFinite(ms) || ms <= meta.coreEndedAtMs + 1000;
});

const usageZero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
function addUsage(target, usage) {
  if (!usage) return;
  for (const key of Object.keys(target)) target[key] += Number(usage[key] ?? 0);
}
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
}

const parentUsage = usageZero();
const nestedUsage = usageZero();
const assistantEntries = [];
const toolCalls = [];
const toolResults = new Map();
let benchmarkUserIndex = -1;

for (let i = 0; i < coreEntries.length; i += 1) {
  const entry = coreEntries[i];
  if (entry.type !== "message") continue;
  const message = entry.message;
  if (message?.role === "user" && messageText(message).includes("BENCH_SUBAGENT_V1")) benchmarkUserIndex = i;
  if (message?.role === "assistant") {
    assistantEntries.push({ index: i, entry });
    addUsage(parentUsage, message.usage);
    for (const part of message.content ?? []) {
      if (part?.type === "toolCall") {
        toolCalls.push({ index: i, id: part.id, name: part.name, args: part.arguments ?? {}, timestamp: entry.timestamp });
      }
    }
  }
  if (message?.role === "toolResult") {
    toolResults.set(message.toolCallId, message);
    addUsage(nestedUsage, message.usage);
  }
}

const firstAssistant = assistantEntries.find((item) => item.index > benchmarkUserIndex)?.entry?.message;
if (!firstAssistant) throw new Error("Could not find first benchmark assistant message.");

const callText = (call) => JSON.stringify(call.args ?? {});
const resultText = (call) => messageText(toolResults.get(call.id));
const findCall = (predicate) => toolCalls.find(predicate);
const findCalls = (predicate) => toolCalls.filter(predicate);
const markerCall = (marker) => findCall((call) => call.name === "subagent" && callText(call).includes(marker));

const single = markerCall("[BENCH:SINGLE]");
const parallel = markerCall("[BENCH:PARALLEL:A]");
const worker = markerCall("[BENCH:WORKER]");
const advanced = markerCall("[BENCH:ADV:SCOUT]");
const asyncCall = markerCall("[BENCH:ASYNC]");
const restore = markerCall("[BENCH:RESTORE:A]");

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

let workerTestsPass = false;
let workerTestOutput = "";
try {
  workerTestOutput = execFileSync(process.execPath, ["--test", path.join(meta.workspace, "code", "test", "normalize.test.mjs")], { encoding: "utf8" });
  workerTestsPass = true;
} catch (error) {
  workerTestOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
const derivedPath = path.join(meta.workspace, "derived.txt");
const derivedExact = fs.existsSync(derivedPath) && fs.readFileSync(derivedPath, "utf8") === "38\n";

const capabilityCalls = findCalls((call) => call.name === "subagent_capability");
const capabilitySequence = capabilityCalls.map((call) => call.args?.mode).filter(Boolean);
const expectedCapabilitySequence = ["advanced", "minimal", "wait", "minimal"];
const capabilityDiscipline = JSON.stringify(capabilitySequence) === JSON.stringify(expectedCapabilitySequence);
const waitCall = findCall((call) => call.name === "subagent_wait");

const staticMetrics = JSON.parse(fs.readFileSync(path.join(runDir, "static.json"), "utf8"));
const scenarioChecks = {
  staticSurface: Boolean(staticMetrics.pass),
  single: Boolean(single && resultText(single).includes("BENCH_SINGLE=17") && !single.args.workflowScript && !single.args.calls),
  parallel: Boolean(parallel && Array.isArray(parallel.args.calls) && parallel.args.calls.length === 3 && includesAll(resultText(parallel), ["BENCH_PARALLEL_A=17", "BENCH_PARALLEL_B=23", "BENCH_PARALLEL_C=41"])),
  worker: Boolean(worker && workerTestsPass && !worker.args.workflowScript),
  advanced: Boolean(advanced && typeof advanced.args.workflowScript === "string" && derivedExact),
  asyncWait: Boolean(asyncCall && asyncCall.args.async === true && waitCall && entries.some((entry) => JSON.stringify(entry).includes("BENCH_ASYNC=ready"))),
  restore: Boolean(restore && Array.isArray(restore.args.calls) && includesAll(resultText(restore), ["BENCH_RESTORE_A=17", "BENCH_RESTORE_B=23"])),
};

const scenarioPassed = Object.values(scenarioChecks).filter(Boolean).length;
const scenarioTotal = Object.keys(scenarioChecks).length;
const firstTurnUsage = {
  input: Number(firstAssistant.usage?.input ?? 0),
  output: Number(firstAssistant.usage?.output ?? 0),
  cacheRead: Number(firstAssistant.usage?.cacheRead ?? 0),
  cacheWrite: Number(firstAssistant.usage?.cacheWrite ?? 0),
  totalTokens: Number(firstAssistant.usage?.totalTokens ?? 0),
};

const subagentCalls = findCalls((call) => call.name === "subagent");
const metrics = {
  runId,
  benchmarkVersion: meta.benchmarkVersion,
  sessionPath,
  sessionBytesAtCollection: fs.statSync(sessionPath).size,
  provider: firstAssistant.provider ?? "unknown",
  model: firstAssistant.model ?? "unknown",
  firstTurnUsage,
  parentUsage,
  nestedToolUsage: nestedUsage,
  coreWallMs: Math.max(0, meta.coreEndedAtMs - meta.startedAtMs),
  static: staticMetrics,
  toolDiscipline: {
    capabilitySequence,
    expectedCapabilitySequence,
    capabilityDiscipline,
    subagentCalls: subagentCalls.length,
    waitCalls: findCalls((call) => call.name === "subagent_wait").length,
    advancedCallIndex: advanced?.index ?? null,
    firstCapabilityIndex: capabilityCalls[0]?.index ?? null,
  },
  scenarios: scenarioChecks,
  scenarioPassed,
  scenarioTotal,
  deterministicPass: scenarioPassed === scenarioTotal && capabilityDiscipline,
  diagnostics: {
    workerTestOutput: workerTestOutput.trim().slice(-4000),
    derivedExact,
    unitTestPass: Boolean(staticMetrics.unitTestPass),
  },
};
fs.writeFileSync(path.join(runDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
meta.sessionPath = sessionPath;
meta.provider = metrics.provider;
meta.model = metrics.model;
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  runId,
  sessionPath,
  deterministicPass: metrics.deterministicPass,
  scenarios: `${scenarioPassed}/${scenarioTotal}`,
  firstTurnUsage,
  parentUsage,
  nestedToolUsage: nestedUsage,
  coreWallMs: metrics.coreWallMs,
  capabilitySequence,
}, null, 2)}\n`);
