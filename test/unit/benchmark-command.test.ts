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
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
	let branch = initialBranch;
	const pi = {
		registerCommand(_name: string, value: RegisteredCommand) {
			command = value;
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
			handlers.set(name, handler);
		},
		sendUserMessage(value: unknown) {
			sent.push(value);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		getActiveTools() {
			return ["read", "bash", "subagent", "subagent_capability"];
		},
		getAllTools() {
			return [
				{ name: "read", description: "read", parameters: {} },
				{ name: "subagent", description: "subagent", parameters: { type: "object" } },
				{ name: "subagent_capability", description: "cap", parameters: { type: "object" } },
				{ name: "subagent_wait", description: "wait", parameters: { type: "object" } },
			];
		},
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
		settled: () => handlers.get("agent_settled")!,
	};
}

function sentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

describe("bench-subagent command", () => {
	it("runs a tiny probe before injecting the cwd-independent v2 specification", async () => {
		const h = harness();
		const previous = process.cwd();
		process.chdir(os.tmpdir());
		try {
			await h.command().handler("", h.ctx as never);
		} finally {
			process.chdir(previous);
		}

		assert.equal(h.sent.length, 1);
		assert.match(sentText(h.sent[0]), /BENCH_SUBAGENT_PROBE_V2/);
		assert.doesNotMatch(sentText(h.sent[0]), /BENCH_SUBAGENT_V2/);
		assert.equal(h.entries[0]?.customType, "pi-subagents-benchmark");
		const cleanContext = (h.entries[0]?.data as {
			cleanContext?: {
				usage?: { tokens?: number };
				piSubagentsActiveToolNames?: string[];
				piSubagentsActiveToolDefinitionBytes?: number;
				subagentWaitActive?: boolean;
			};
		}).cleanContext;
		assert.equal(cleanContext?.usage?.tokens, 1234);
		assert.deepEqual(cleanContext?.piSubagentsActiveToolNames, ["subagent", "subagent_capability"]);
		assert.equal((cleanContext?.piSubagentsActiveToolDefinitionBytes ?? 0) > 0, true);
		assert.equal(cleanContext?.subagentWaitActive, false);

		h.setBranch([
			{ type: "message", message: { role: "user", content: "BENCH_SUBAGENT_PROBE_V2\nReply exactly BENCH_PROBE_OK and do not call tools." } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "BENCH_PROBE_OK" }] } },
		]);
		await h.settled()({}, h.ctx as never);

		assert.equal(h.sent.length, 2);
		const spec = sentText(h.sent[1]);
		assert.match(spec, /BENCH_SUBAGENT_V2/);
		assert.match(spec, /Resolved package root:/);
		assert.doesNotMatch(spec, /node --experimental-strip-types benchmarks\/scripts\/start-run\.mjs/);
		assert.match(spec, /benchmarks\/scripts\/start-run\.mjs/);
	});

	it("does not inject the specification twice after the v2 marker exists", async () => {
		const h = harness([
			{ type: "message", message: { role: "user", content: "BENCH_SUBAGENT_PROBE_V2" } },
			{ type: "message", message: { role: "assistant", content: "BENCH_PROBE_OK" } },
			{ type: "message", message: { role: "user", content: "BENCH_SUBAGENT_V2" } },
		]);
		await h.settled()({}, h.ctx as never);
		assert.equal(h.sent.length, 0);
	});

	it("refuses to contaminate an existing session", async () => {
		const h = harness([{ type: "message", message: { role: "user", content: "already used" } }]);
		await h.command().handler("", h.ctx as never);
		assert.equal(h.sent.length, 0);
		assert.equal(h.notifications.some((message) => message.includes("fresh Pi session")), true);
	});

	it("generates workflow children with runs.run(key, params)", () => {
		const scriptPath = fileURLToPath(new URL("../../benchmarks/scripts/start-run.mjs", import.meta.url));
		const source = fs.readFileSync(scriptPath, "utf8");
		assert.equal(source.includes('runs.run("seed", { agent:'), true);
		assert.equal(source.includes('runs.run("write", { agent:'), true);
		assert.equal(source.includes("runs.run({ key:"), false);
	});
});
