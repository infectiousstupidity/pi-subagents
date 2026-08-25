import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const benchmarkPath = fileURLToPath(new URL("../../benchmarks/BENCHMARK.md", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const STATE_TYPE = "pi-subagents-benchmark";
const PROBE_MARKER = "BENCH_SUBAGENT_PROBE_V4";
const SPEC_MARKER = "BENCH_SUBAGENT_V4";
const KNOWN_SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_capability", "subagent_wait"]);

type SourceInfoLike = {
	path?: string;
	source?: string;
	baseDir?: string;
};

type ToolInfoLike = {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: unknown;
	sourceInfo?: SourceInfoLike;
};

function portablePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function comparablePath(value: string): string {
	const normalized = portablePath(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveBenchmarkSpec(source: string): string {
	const root = portablePath(packageRoot);
	return source
		.replace(
			"node --experimental-strip-types benchmarks/scripts/start-run.mjs",
			`node --experimental-strip-types "${root}/benchmarks/scripts/start-run.mjs"`,
		)
		.replace(
			"node benchmarks/scripts/collect-session.mjs <runId>",
			`node "${root}/benchmarks/scripts/collect-session.mjs" <runId>`,
		)
		.replace(
			"node benchmarks/scripts/finalize-run.mjs <runId>",
			`node "${root}/benchmarks/scripts/finalize-run.mjs" <runId>`,
		);
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => Boolean(part && typeof part === "object" && "type" in part))
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function hasUserMarker(branch: unknown[], marker: string): boolean {
	return branch.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const message = (entry as { message?: { role?: string; content?: unknown } }).message;
		return message?.role === "user" && messageText(message).includes(marker);
	});
}

function hasExistingUserMessage(branch: unknown[]): boolean {
	return branch.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		return (entry as { message?: { role?: string } }).message?.role === "user";
	});
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

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function sourceInfoBelongsToPiSubagents(sourceInfo: SourceInfoLike | undefined): boolean {
	if (!sourceInfo) return false;
	const root = comparablePath(packageRoot);
	for (const candidate of [sourceInfo.path, sourceInfo.baseDir]) {
		if (!candidate) continue;
		const normalized = comparablePath(candidate);
		if (normalized === root || normalized.startsWith(`${root}/`)) return true;
	}
	return typeof sourceInfo.source === "string" && sourceInfo.source.toLowerCase().includes("pi-subagents");
}

function belongsToPiSubagents(tool: ToolInfoLike): boolean {
	return sourceInfoBelongsToPiSubagents(tool.sourceInfo) || KNOWN_SUBAGENT_TOOL_NAMES.has(tool.name);
}

function surfaceSnapshot(pi: ExtensionAPI) {
	const activeToolNames = pi.getActiveTools();
	const active = new Set(activeToolNames);
	const activeTools = (pi.getAllTools() as ToolInfoLike[]).filter((tool) => active.has(tool.name));
	const activeContracts = activeTools.map(modelFacingContract);
	const subagentTools = activeTools.filter(belongsToPiSubagents);
	const subagentContracts = subagentTools.map(modelFacingContract);
	return {
		activeToolNames,
		activeModelFacingToolDefinitionBytes: bytes(activeContracts),
		piSubagentsActiveToolNames: subagentTools.map((tool) => tool.name),
		piSubagentsModelFacingToolDefinitionBytes: bytes(subagentContracts),
		piSubagentsModelFacingBytesByTool: Object.fromEntries(
			subagentTools.map((tool) => [tool.name, bytes(modelFacingContract(tool))]),
		),
		piSubagentsOwnershipSourceInfoCount: subagentTools.filter((tool) => sourceInfoBelongsToPiSubagents(tool.sourceInfo)).length,
		subagentWaitActive: active.has("subagent_wait"),
	};
}

function appendProbeState(pi: ExtensionAPI, ctx: {
	getContextUsage(): unknown;
	getSystemPrompt(): string;
}): void {
	pi.appendEntry(STATE_TYPE, {
		version: 4,
		phase: "probe-sent",
		at: Date.now(),
		cleanContext: {
			usage: ctx.getContextUsage() ?? null,
			systemPromptBytes: Buffer.byteLength(ctx.getSystemPrompt()),
			surface: surfaceSnapshot(pi),
		},
	});
}

function sendResolvedSpec(pi: ExtensionAPI, ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): void {
	let source: string;
	try {
		source = fs.readFileSync(benchmarkPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Cannot load pi-subagents benchmark: ${message}`, "error");
		return;
	}
	pi.appendEntry(STATE_TYPE, { version: 4, phase: "spec-sent", at: Date.now() });
	pi.sendUserMessage([
		{ type: "text", text: SPEC_MARKER },
		{ type: "text", text: `Resolved package root: ${portablePath(packageRoot)}\n\n${resolveBenchmarkSpec(source)}` },
	]);
}

export function registerBenchmarkCommand(pi: ExtensionAPI): void {
	let benchmarkActive = false;
	let surfaceSequence = 0;

	pi.on("session_start", () => {
		benchmarkActive = false;
		surfaceSequence = 0;
	});

	pi.registerCommand("bench-subagent", {
		description: "Run the minimal reproducible pi-subagents benchmark",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Wait for the current turn to finish, then run /bench-subagent in a new session.", "warning");
				return;
			}
			if (hasExistingUserMessage(ctx.sessionManager.getBranch() as unknown[])) {
				if (ctx.hasUI) ctx.ui.notify("/bench-subagent requires a fresh Pi session with no earlier user messages.", "warning");
				return;
			}

			benchmarkActive = true;
			surfaceSequence = 0;
			appendProbeState(pi, ctx);
			pi.sendUserMessage(`${PROBE_MARKER}\nReply exactly BENCH_PROBE_OK and do not call tools.`);
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!benchmarkActive) return;
		const branch = ctx.sessionManager.getBranch() as unknown[];
		if (!hasUserMarker(branch, PROBE_MARKER) || hasUserMarker(branch, SPEC_MARKER)) return;
		sendResolvedSpec(pi, ctx);
	});

	pi.on("tool_execution_end", (event) => {
		if (!benchmarkActive || event.toolName !== "subagent_capability") return;
		pi.appendEntry(STATE_TYPE, {
			version: 4,
			phase: "surface",
			sequence: ++surfaceSequence,
			at: Date.now(),
			surface: surfaceSnapshot(pi),
		});
	});
}
