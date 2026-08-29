import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextSurfaceController } from "../../src/extension/context-surface.ts";
import {
	compareBenchmarkResults,
	registerBenchmarkCommand,
	summarizeParentUsage,
} from "../../src/extension/benchmark-command.ts";

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
};

function harness(initialBranch: unknown[] = []) {
	let command: RegisteredCommand | undefined;
	let branch = initialBranch;
	const sent: string[] = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => void | Promise<void>>();
	let activeTools = ["read", "bash", "subagent", "subagent_capability"];
	let progressiveCalls = 0;
	let upstreamCalls = 0;

	const allTools = [
		{ name: "read", description: "read", parameters: {} },
		{ name: "bash", description: "bash", parameters: {} },
		{ name: "subagent", description: "subagent", parameters: { type: "object" } },
		{ name: "subagent_capability", description: "capability", parameters: { type: "object" } },
		{ name: "subagent_wait", description: "wait", parameters: { type: "object" } },
	];
	const pi = {
		registerCommand(_name: string, value: RegisteredCommand) { command = value; },
		on(name: string, handler: (event: any, ctx: any) => void | Promise<void>) { handlers.set(name, handler); },
		async sendUserMessage(value: string) { sent.push(value); },
		getActiveTools() { return activeTools; },
		getAllTools() { return allTools; },
	} as unknown as ExtensionAPI;
	const controller: ContextSurfaceController = {
		useProgressiveSurface() {
			progressiveCalls += 1;
			activeTools = ["read", "bash", "subagent", "subagent_capability"];
		},
		useUpstreamSurface() {
			upstreamCalls += 1;
			activeTools = ["read", "bash", "subagent", "subagent_wait"];
		},
	};
	registerBenchmarkCommand(pi, controller);
	const ctx = {
		isIdle: () => true,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => branch },
	};
	return {
		command: () => command!,
		sent,
		notifications,
		ctx,
		progressiveCalls: () => progressiveCalls,
		upstreamCalls: () => upstreamCalls,
		setBranch(value: unknown[]) { branch = value; },
	};
}

describe("bench-subagent A/B command", () => {
	it("defaults to the progressive surface and sends one fixed workload", async () => {
		const h = harness();
		await h.command().handler("", h.ctx);
		assert.equal(h.progressiveCalls(), 1);
		assert.equal(h.upstreamCalls(), 0);
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0]!, /BENCH_SUBAGENT_AB_V5/);
		assert.match(h.sent[0]!, /mode="all" once/);
		assert.match(h.sent[0]!, /Do not unload capabilities/);
	});

	it("can expose the real upstream surface for the baseline", async () => {
		const h = harness();
		await h.command().handler("upstream", h.ctx);
		assert.equal(h.progressiveCalls(), 0);
		assert.equal(h.upstreamCalls(), 1);
		assert.equal(h.sent.length, 1);
	});

	it("refuses to benchmark inside an existing conversation", async () => {
		const h = harness([{ type: "message", message: { role: "user", content: "already used" } }]);
		await h.command().handler("progressive", h.ctx);
		assert.equal(h.sent.length, 0);
		assert.equal(h.notifications.some((message) => message.includes("fresh Pi session")), true);
	});

	it("counts every parent model request including cache traffic", () => {
		const usage = summarizeParentUsage([
			{ role: "user", content: "ignored" },
			{ role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5 } },
			{ role: "toolResult", content: [] },
			{ role: "assistant", usage: { input: 20, output: 4, cacheRead: 80, cacheWrite: 0 } },
		]);
		assert.deepEqual(usage, {
			input: 120,
			output: 14,
			cacheRead: 130,
			cacheWrite: 5,
			promptTokens: 255,
			accountedTokens: 269,
			modelRequests: 2,
		});
	});

	it("reports positive savings when progressive uses fewer total parent tokens", () => {
		const base = {
			usage: { accountedTokens: 1000, promptTokens: 900, modelRequests: 4 },
		} as any;
		const progressive = {
			usage: { accountedTokens: 800, promptTokens: 700, modelRequests: 5 },
		} as any;
		const comparison = compareBenchmarkResults(progressive, base);
		assert.equal(comparison.savedTokens, 200);
		assert.equal(comparison.savedPercent, 20);
		assert.equal(comparison.progressiveRequests, 5);
		assert.equal(comparison.upstreamRequests, 4);
	});
});
