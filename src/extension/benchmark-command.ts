import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextSurfaceController } from "./context-surface.ts";

const BENCHMARK_VERSION = 5;
const BENCHMARK_MARKER = "BENCH_SUBAGENT_AB_V5";
const RESULTS_DIR = path.join(os.homedir(), ".pi", "benchmarks", "pi-subagents", "ab-v5");
const PAIR_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ALLOWED_TOOL_NAMES = new Set(["subagent", "subagent_capability", "subagent_wait"]);

type BenchmarkMode = "progressive" | "upstream";
type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};
type ToolCallRecord = { name: string; args: unknown };
type ParentUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	accountedTokens: number;
	modelRequests: number;
};
type SurfaceSnapshot = {
	activeToolNames: string[];
	piSubagentsActiveToolNames: string[];
	piSubagentsModelFacingToolDefinitionBytes: number;
	piSubagentsModelFacingBytesByTool: Record<string, number>;
};
type BenchmarkResult = {
	benchmarkVersion: number;
	mode: BenchmarkMode;
	createdAt: string;
	createdAtMs: number;
	provider: string;
	model: string;
	valid: boolean;
	invalidReasons: string[];
	usage: ParentUsage;
	startSurface: SurfaceSnapshot;
	toolCalls: ToolCallRecord[];
	capabilityModes: string[];
	toolErrors: string[];
	finalText: string;
};

type ActiveRun = {
	mode: BenchmarkMode;
	startedAtMs: number;
	startSurface: SurfaceSnapshot;
	toolCalls: ToolCallRecord[];
	toolErrors: string[];
};

type ToolInfoLike = {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: unknown;
};

const SINGLE_TASK = "[BENCH:SINGLE] Return exactly BENCH_SINGLE=ok and nothing else.";
const PARALLEL_A_TASK = "[BENCH:PARALLEL:A] Return exactly BENCH_PARALLEL_A=ok and nothing else.";
const PARALLEL_B_TASK = "[BENCH:PARALLEL:B] Return exactly BENCH_PARALLEL_B=ok and nothing else.";
const ADVANCED_TASK = "[BENCH:ADVANCED] Return exactly BENCH_ADVANCED=ok and nothing else.";
const ASYNC_TASK = "[BENCH:ASYNC] Return exactly BENCH_ASYNC=ready and nothing else.";
const PARALLEL_WORKFLOW = `return await runs.all(${JSON.stringify([
	{ key: "parallel-a", agent: "scout", task: PARALLEL_A_TASK },
	{ key: "parallel-b", agent: "scout", task: PARALLEL_B_TASK },
])});`;
const ADVANCED_WORKFLOW = `const result = await runs.run("advanced", { agent: "scout", task: ${JSON.stringify(ADVANCED_TASK)} });\nreturn result.output;`;

const BENCHMARK_PROMPT = `${BENCHMARK_MARKER}
This is a token-cost benchmark. Follow these steps exactly. Do not retry failed calls, inspect files, run shell commands, or call unrelated tools.

1. Call subagent once with agent="scout", task=${JSON.stringify(SINGLE_TASK)}, context="fresh", async=false.

2. Run exactly two scout children in parallel with context="fresh" and async=false, using one parent subagent call. If calls[] is available, use calls[] with these tasks:
- ${PARALLEL_A_TASK}
- ${PARALLEL_B_TASK}
Otherwise use workflowScript exactly as follows:
${PARALLEL_WORKFLOW}

3. Run one foreground advanced workflow with context="fresh" and async=false using workflowScript exactly as follows:
${ADVANCED_WORKFLOW}

4. Start one scout child with task=${JSON.stringify(ASYNC_TASK)}, context="fresh", async=true. Then call subagent_wait with all=true and timeoutMs=120000.

If workflowScript and/or subagent_wait are not currently available, use subagent_capability before the first missing capability. If both are missing, load mode="all" once. Do not unload capabilities; the extension resets them automatically after the turn.

After the wait completes, return exactly BENCH_DONE and nothing else.`;

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function modelFacingContract(tool: ToolInfoLike): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.promptSnippet !== undefined ? { promptSnippet: tool.promptSnippet } : {}),
		...(tool.promptGuidelines !== undefined ? { promptGuidelines: tool.promptGuidelines } : {}),
	};
}

function surfaceSnapshot(pi: ExtensionAPI): SurfaceSnapshot {
	const activeToolNames = pi.getActiveTools();
	const active = new Set(activeToolNames);
	const tools = (pi.getAllTools() as ToolInfoLike[])
		.filter((tool) => active.has(tool.name) && ALLOWED_TOOL_NAMES.has(tool.name));
	return {
		activeToolNames,
		piSubagentsActiveToolNames: tools.map((tool) => tool.name),
		piSubagentsModelFacingToolDefinitionBytes: bytes(tools.map(modelFacingContract)),
		piSubagentsModelFacingBytesByTool: Object.fromEntries(
			tools.map((tool) => [tool.name, bytes(modelFacingContract(tool))]),
		),
	};
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === "object"))
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function hasExistingUserMessage(branch: unknown[]): boolean {
	return branch.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		return (entry as { message?: { role?: string } }).message?.role === "user";
	});
}

export function summarizeParentUsage(messages: unknown[]): ParentUsage {
	const usage: ParentUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		promptTokens: 0,
		accountedTokens: 0,
		modelRequests: 0,
	};
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: string; usage?: UsageLike };
		if (candidate.role !== "assistant" || !candidate.usage) continue;
		usage.input += Number(candidate.usage.input ?? 0);
		usage.output += Number(candidate.usage.output ?? 0);
		usage.cacheRead += Number(candidate.usage.cacheRead ?? 0);
		usage.cacheWrite += Number(candidate.usage.cacheWrite ?? 0);
		usage.modelRequests += 1;
	}
	usage.promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	usage.accountedTokens = usage.promptTokens + usage.output;
	return usage;
}

function providerAndModel(messages: unknown[]): { provider: string; model: string } {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: string; provider?: string; model?: string };
		if (candidate.role !== "assistant") continue;
		return { provider: candidate.provider ?? "unknown", model: candidate.model ?? "unknown" };
	}
	return { provider: "unknown", model: "unknown" };
}

function finalAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: string }).role !== "assistant") continue;
		const text = messageText(message).trim();
		if (text) return text;
	}
	return "";
}

function parseMode(args: string): BenchmarkMode | undefined {
	const value = args.trim().toLowerCase();
	if (!value || value === "progressive") return "progressive";
	if (value === "upstream") return "upstream";
	return undefined;
}

function validateRun(run: ActiveRun, finalText: string): string[] {
	const reasons: string[] = [];
	const subagentCalls = run.toolCalls.filter((call) => call.name === "subagent");
	const waitCalls = run.toolCalls.filter((call) => call.name === "subagent_wait");
	const capabilityCalls = run.toolCalls.filter((call) => call.name === "subagent_capability");
	const capabilityModes = capabilityCalls
		.map((call) => (call.args as { mode?: unknown } | undefined)?.mode)
		.filter((mode): mode is string => typeof mode === "string");
	const unexpected = run.toolCalls.filter((call) => !ALLOWED_TOOL_NAMES.has(call.name));

	if (subagentCalls.length !== 4) reasons.push(`expected 4 parent subagent calls, got ${subagentCalls.length}`);
	if (waitCalls.length !== 1) reasons.push(`expected 1 subagent_wait call, got ${waitCalls.length}`);
	if (unexpected.length > 0) reasons.push(`unexpected tools: ${unexpected.map((call) => call.name).join(", ")}`);
	if (run.toolErrors.length > 0) reasons.push(`tool errors: ${run.toolErrors.join(", ")}`);
	if (finalText !== "BENCH_DONE") reasons.push(`expected final BENCH_DONE, got ${JSON.stringify(finalText)}`);

	if (run.mode === "upstream") {
		if (capabilityCalls.length !== 0) reasons.push(`upstream baseline used ${capabilityCalls.length} capability calls`);
		if (!run.startSurface.piSubagentsActiveToolNames.includes("subagent_wait")) reasons.push("upstream baseline did not start with subagent_wait");
		if (run.startSurface.piSubagentsActiveToolNames.includes("subagent_capability")) reasons.push("upstream baseline exposed subagent_capability");
	} else {
		const advancedLoaded = capabilityModes.includes("advanced") || capabilityModes.includes("all");
		const waitLoaded = capabilityModes.includes("wait") || capabilityModes.includes("all");
		if (!advancedLoaded || !waitLoaded) reasons.push(`progressive run did not load both required capabilities: ${capabilityModes.join(" -> ") || "none"}`);
		if (capabilityCalls.length > 2) reasons.push(`progressive run used ${capabilityCalls.length} capability calls`);
		if (run.startSurface.piSubagentsActiveToolNames.includes("subagent_wait")) reasons.push("progressive run started with subagent_wait active");
		if (!run.startSurface.piSubagentsActiveToolNames.includes("subagent_capability")) reasons.push("progressive run did not expose subagent_capability");
	}

	return reasons;
}

function resultPath(mode: BenchmarkMode): string {
	return path.join(RESULTS_DIR, `${mode}.json`);
}

function readResult(mode: BenchmarkMode): BenchmarkResult | undefined {
	try {
		return JSON.parse(fs.readFileSync(resultPath(mode), "utf8")) as BenchmarkResult;
	} catch {
		return undefined;
	}
}

function writeResult(result: BenchmarkResult): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.writeFileSync(resultPath(result.mode), `${JSON.stringify(result, null, 2)}\n`);
}

export function compareBenchmarkResults(progressive: BenchmarkResult, upstream: BenchmarkResult) {
	const savedTokens = upstream.usage.accountedTokens - progressive.usage.accountedTokens;
	const savedPercent = upstream.usage.accountedTokens > 0
		? (savedTokens / upstream.usage.accountedTokens) * 100
		: 0;
	return {
		savedTokens,
		savedPercent,
		progressiveTokens: progressive.usage.accountedTokens,
		upstreamTokens: upstream.usage.accountedTokens,
		progressivePromptTokens: progressive.usage.promptTokens,
		upstreamPromptTokens: upstream.usage.promptTokens,
		progressiveRequests: progressive.usage.modelRequests,
		upstreamRequests: upstream.usage.modelRequests,
	};
}

function sameComparableEnvironment(a: BenchmarkResult, b: BenchmarkResult): boolean {
	return a.valid
		&& b.valid
		&& a.benchmarkVersion === b.benchmarkVersion
		&& a.provider === b.provider
		&& a.model === b.model
		&& Math.abs(a.createdAtMs - b.createdAtMs) <= PAIR_MAX_AGE_MS;
}

function writeComparison(progressive: BenchmarkResult, upstream: BenchmarkResult): string {
	const comparison = compareBenchmarkResults(progressive, upstream);
	const direction = comparison.savedTokens >= 0 ? "saved" : "cost";
	const magnitude = Math.abs(comparison.savedTokens);
	const percent = Math.abs(comparison.savedPercent).toFixed(1);
	const verdict = comparison.savedTokens >= 0
		? `Progressive disclosure saved ${magnitude} parent tokens (${percent}%).`
		: `Progressive disclosure cost ${magnitude} more parent tokens (${percent}%).`;
	const report = `# pi-subagents A/B token benchmark\n\n${verdict}\n\n`
		+ `Provider/model: \`${progressive.provider}/${progressive.model}\`\n\n`
		+ `| Metric | Progressive | Upstream |\n|---|---:|---:|\n`
		+ `| Parent accounted tokens | ${comparison.progressiveTokens} | ${comparison.upstreamTokens} |\n`
		+ `| Parent prompt tokens | ${comparison.progressivePromptTokens} | ${comparison.upstreamPromptTokens} |\n`
		+ `| Parent model requests | ${comparison.progressiveRequests} | ${comparison.upstreamRequests} |\n`
		+ `| Starting pi-subagents tool bytes | ${progressive.startSurface.piSubagentsModelFacingToolDefinitionBytes} | ${upstream.startSurface.piSubagentsModelFacingToolDefinitionBytes} |\n\n`
		+ `Delta: ${direction} ${magnitude} tokens (${percent}%).\n`;
	fs.writeFileSync(path.join(RESULTS_DIR, "RESULTS.md"), report);
	return verdict;
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

export function registerBenchmarkCommand(pi: ExtensionAPI, surfaceController: ContextSurfaceController): void {
	let activeRun: ActiveRun | undefined;

	pi.on("session_start", () => {
		activeRun = undefined;
	});

	pi.registerCommand("bench-subagent", {
		description: "A/B benchmark progressive vs upstream subagent token cost",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				notify(ctx, "Wait for the current turn to finish, then run the benchmark in a fresh session.", "warning");
				return;
			}
			if (hasExistingUserMessage(ctx.sessionManager.getBranch() as unknown[])) {
				notify(ctx, "/bench-subagent requires a fresh Pi session with no earlier user messages.", "warning");
				return;
			}
			const mode = parseMode(args);
			if (!mode) {
				notify(ctx, "Usage: /bench-subagent [progressive|upstream]", "warning");
				return;
			}

			if (mode === "progressive") surfaceController.useProgressiveSurface();
			else surfaceController.useUpstreamSurface();

			activeRun = {
				mode,
				startedAtMs: Date.now(),
				startSurface: surfaceSnapshot(pi),
				toolCalls: [],
				toolErrors: [],
			};

			try {
				await pi.sendUserMessage(BENCHMARK_PROMPT);
			} catch (error) {
				activeRun = undefined;
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `Could not start benchmark: ${message}`, "error");
			}
		},
	});

	pi.on("tool_execution_start", (event) => {
		if (!activeRun) return;
		activeRun.toolCalls.push({ name: event.toolName, args: event.args });
	});

	pi.on("tool_execution_end", (event) => {
		if (!activeRun || !event.isError) return;
		activeRun.toolErrors.push(event.toolName);
	});

	pi.on("agent_end", (event, ctx) => {
		const run = activeRun;
		if (!run) return;
		activeRun = undefined;
		const messages = event.messages as unknown[];
		const finalText = finalAssistantText(messages);
		const invalidReasons = validateRun(run, finalText);
		const identity = providerAndModel(messages);
		const result: BenchmarkResult = {
			benchmarkVersion: BENCHMARK_VERSION,
			mode: run.mode,
			createdAt: new Date().toISOString(),
			createdAtMs: Date.now(),
			provider: identity.provider,
			model: identity.model,
			valid: invalidReasons.length === 0,
			invalidReasons,
			usage: summarizeParentUsage(messages),
			startSurface: run.startSurface,
			toolCalls: run.toolCalls,
			capabilityModes: run.toolCalls
				.filter((call) => call.name === "subagent_capability")
				.map((call) => (call.args as { mode?: unknown } | undefined)?.mode)
				.filter((mode): mode is string => typeof mode === "string"),
			toolErrors: run.toolErrors,
			finalText,
		};

		try {
			writeResult(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Benchmark completed but result write failed: ${message}`, "error");
			return;
		}

		if (!result.valid) {
			notify(ctx, `Benchmark INVALID: ${result.invalidReasons.join("; ")}`, "warning");
			return;
		}

		const otherMode: BenchmarkMode = result.mode === "progressive" ? "upstream" : "progressive";
		const other = readResult(otherMode);
		if (!other || !sameComparableEnvironment(result, other)) {
			notify(ctx, `${result.mode} result: ${result.usage.accountedTokens} parent tokens. Start a new session and run /bench-subagent ${otherMode} with the same model.`);
			return;
		}

		const progressive = result.mode === "progressive" ? result : other;
		const upstream = result.mode === "upstream" ? result : other;
		const verdict = writeComparison(progressive, upstream);
		notify(ctx, `${verdict} Results: ${path.join(RESULTS_DIR, "RESULTS.md")}`);
	});
}
