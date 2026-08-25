import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBenchmarkCommand } from "../../src/extension/benchmark-command.ts";

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
};

function harness(initialBranch: unknown[] = []) {
	let command: RegisteredCommand | undefined;
	const sent: unknown[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => void | Promise<void>>();
	let branch = initialBranch;
	let activeTools = ["read", "bash", "subagent", "subagent_capability", "future_package_tool"];
	const packageSource = { path: "/outside/package.ts", source: "github:infectiousstupidity/pi-subagents", scope: "user", origin: "package" };
	const otherSource = { path: "/outside/other.ts", source: "builtin", scope: "user", origin: "top-level" };
	const allTools = [
		{ name: "read", description: "read", parameters: {}, sourceInfo: otherSource },
		{ name: "bash", description: "bash", parameters: {}, sourceInfo: otherSource },
		{ name: "subagent", description: "compact", parameters: { type: "object" }, promptSnippet: "compact", sourceInfo: packageSource },
		{ name: "subagent_capability", description: "cap", parameters: { type: "object" }, sourceInfo: packageSource },
		{ name: "subagent_wait", description: "wait", parameters: { type: "object" }, sourceInfo: packageSource },
		{ name: "future_package_tool", description: "future", parameters: { type: "object" }, sourceInfo: packageSource },
	];
	const pi = {
		registerCommand(_name: string, value: RegisteredCommand) { command = value; },
		on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { handlers.set(name, handler); },
		sendUserMessage(value: unknown) { sent.push(value); },
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		getActiveTools() { return activeTools; },
		getAllTools() { return allTools; },
	} as unknown as ExtensionAPI;
	registerBenchmarkCommand(pi);
	const ctx = {
		isIdle: () => true,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens: 1234, contextWindow: 65536, percent: 1.9 }),
		getSystemPrompt: () => "system prompt",
	};
	return {
		command: () => command!,
		sent,
		entries,
		notifications,
		ctx,
		setBranch(value: unknown[]) { branch = value; },
		setActiveTools(value: string[]) { activeTools = value; },
		event: (name: string) => handlers.get(name)!,
	};
}

function sentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

describe("bench-subagent command", () => {
	it("probes before injecting the v4 specification and attributes package-owned tools via SourceInfo", async () => {
		const h = harness();
		const previous = process.cwd();
		process.chdir(os.tmpdir());
		try {
			await h.command().handler("", h.ctx as never);
		} finally {
			process.chdir(previous);
		}

		assert.equal(h.sent.length, 1);
		assert.match(sentText(h.sent[0]), /BENCH_SUBAGENT_PROBE_V4/);
		assert.doesNotMatch(sentText(h.sent[0]), /BENCH_SUBAGENT_V4/);
		const cleanContext = (h.entries[0]?.data as any).cleanContext;
		assert.equal(cleanContext.usage.tokens, 1234);
		assert.deepEqual(cleanContext.surface.piSubagentsActiveToolNames, ["subagent", "subagent_capability", "future_package_tool"]);
		assert.equal(cleanContext.surface.piSubagentsOwnershipSourceInfoCount, 3);
		assert.equal(cleanContext.surface.subagentWaitActive, false);
		assert.equal(cleanContext.surface.piSubagentsModelFacingToolDefinitionBytes > 0, true);

		h.setBranch([
			{ type: "message", message: { role: "user", content: "BENCH_SUBAGENT_PROBE_V4\nReply exactly BENCH_PROBE_OK and do not call tools." } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "BENCH_PROBE_OK" }] } },
		]);
		await h.event("agent_settled")({}, h.ctx);
		assert.equal(h.sent.length, 2);
		assert.match(sentText(h.sent[1]), /BENCH_SUBAGENT_V4/);
		assert.match(sentText(h.sent[1]), /Resolved package root:/);
	});

	it("records capability surface changes without another child run", async () => {
		const h = harness();
		await h.command().handler("", h.ctx as never);
		h.setActiveTools(["read", "bash", "subagent", "subagent_capability", "subagent_wait", "future_package_tool"]);
		await h.event("tool_execution_end")({ toolName: "subagent_capability", toolCallId: "cap-1", result: {}, isError: false }, h.ctx);
		const surfaceEntry = h.entries.find((entry) => (entry.data as any)?.phase === "surface");
		assert.ok(surfaceEntry);
		assert.equal((surfaceEntry!.data as any).sequence, 1);
		assert.equal((surfaceEntry!.data as any).surface.subagentWaitActive, true);
		assert.deepEqual((surfaceEntry!.data as any).surface.piSubagentsActiveToolNames, ["subagent", "subagent_capability", "subagent_wait", "future_package_tool"]);
	});

	it("refuses to contaminate an existing session", async () => {
		const h = harness([{ type: "message", message: { role: "user", content: "already used" } }]);
		await h.command().handler("", h.ctx as never);
		assert.equal(h.sent.length, 0);
		assert.equal(h.notifications.some((message) => message.includes("fresh Pi session")), true);
	});

	it("keeps the benchmark small and guards the measurement fixes", () => {
		const root = new URL("../../", import.meta.url);
		const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL("benchmarks/benchmark.json", root)), "utf8"));
		const spec = fs.readFileSync(fileURLToPath(new URL("benchmarks/BENCHMARK.md", root)), "utf8");
		const start = fs.readFileSync(fileURLToPath(new URL("benchmarks/scripts/start-run.mjs", root)), "utf8");
		const collect = fs.readFileSync(fileURLToPath(new URL("benchmarks/scripts/collect-session.mjs", root)), "utf8");
		assert.equal(config.version, 4);
		assert.equal(config.expectedCoreSubagentCalls, 4);
		assert.equal(config.expectedChildRuns, 5);
		assert.doesNotMatch(spec, /BENCH:WORKER|BENCH:REVIEW|BENCH:RESTORE/);
		assert.match(start, /runs\.run\("advanced", \{ agent: "scout"/);
		assert.match(start, /runPreserveLeading\("git", \["status", "--porcelain=v1"\]\)/);
		assert.doesNotMatch(start, /derived\.txt|normalize\.mjs|workflow-seed/);
		assert.match(collect, /cleanProbeToolFree = probeAssistantEntries\.length === 1 && cleanProbeToolCalls\.length === 0/);
		assert.match(collect, /cleanPromptTokens = promptTokens\(probeAssistant\.usage\)/);
		assert.match(collect, /BENCH_SUBAGENT_V4/);
	});
});
