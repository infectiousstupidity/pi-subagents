import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const benchmarkPath = fileURLToPath(new URL("../../benchmarks/BENCHMARK.md", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const STATE_TYPE = "pi-subagents-benchmark";
const PROBE_MARKER = "BENCH_SUBAGENT_PROBE_V2";
const SPEC_MARKER = "BENCH_SUBAGENT_V2";

function portablePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveBenchmarkSpec(source: string): string {
	const root = portablePath(packageRoot);
	const specPath = portablePath(benchmarkPath);
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
		)
		.replace(
			"this benchmark specification embedded in the saved session.",
			`this benchmark specification embedded in the saved session (source: \`${specPath}\`).`,
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

function activeToolBytes(pi: ExtensionAPI): number {
	try {
		const active = new Set(pi.getActiveTools());
		const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
		return Buffer.byteLength(JSON.stringify(tools));
	} catch {
		return -1;
	}
}

function appendProbeState(pi: ExtensionAPI, ctx: {
	getContextUsage(): unknown;
	getSystemPrompt(): string;
}): void {
	const usage = ctx.getContextUsage();
	pi.appendEntry(STATE_TYPE, {
		version: 2,
		phase: "probe-sent",
		at: Date.now(),
		cleanContext: {
			usage: usage ?? null,
			systemPromptBytes: Buffer.byteLength(ctx.getSystemPrompt()),
			activeToolNames: pi.getActiveTools(),
			activeToolDefinitionBytes: activeToolBytes(pi),
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
	pi.appendEntry(STATE_TYPE, { version: 2, phase: "spec-sent", at: Date.now() });
	pi.sendUserMessage([
		{ type: "text", text: SPEC_MARKER },
		{ type: "text", text: `Resolved package root: ${portablePath(packageRoot)}\n\n${resolveBenchmarkSpec(source)}` },
	]);
}

export function registerBenchmarkCommand(pi: ExtensionAPI): void {
	pi.registerCommand("bench-subagent", {
		description: "Run the reproducible pi-subagents benchmark",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Wait for the current turn to finish, then run /bench-subagent in a new session.", "warning");
				return;
			}
			if (hasExistingUserMessage(ctx.sessionManager.getBranch() as unknown[])) {
				if (ctx.hasUI) ctx.ui.notify("/bench-subagent requires a fresh Pi session with no earlier user messages.", "warning");
				return;
			}

			appendProbeState(pi, ctx);
			pi.sendUserMessage(
				`${PROBE_MARKER}\nReply exactly BENCH_PROBE_OK and do not call tools.`,
			);
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as unknown[];
		if (!hasUserMarker(branch, PROBE_MARKER) || hasUserMarker(branch, SPEC_MARKER)) return;
		sendResolvedSpec(pi, ctx);
	});
}
