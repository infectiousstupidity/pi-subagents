import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBenchmarkCommand } from "../../src/extension/benchmark-command.ts";

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
};

function harness(branch: unknown[] = []) {
	let command: RegisteredCommand | undefined;
	let sent: unknown;
	const notifications: string[] = [];
	const pi = {
		registerCommand(_name: string, value: RegisteredCommand) {
			command = value;
		},
		sendUserMessage(value: unknown) {
			sent = value;
		},
	} as unknown as ExtensionAPI;
	registerBenchmarkCommand(pi);
	const ctx = {
		isIdle: () => true,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => branch },
	};
	return { command: () => command!, sent: () => sent, notifications, ctx };
}

function sentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

describe("bench-subagent command", () => {
	it("resolves package paths independently of the Pi cwd", async () => {
		const h = harness();
		const previous = process.cwd();
		process.chdir(os.tmpdir());
		try {
			await h.command().handler("", h.ctx as never);
		} finally {
			process.chdir(previous);
		}
		const text = sentText(h.sent());
		assert.match(text, /BENCH_SUBAGENT_V1/);
		assert.match(text, /Resolved package root:/);
		assert.doesNotMatch(text, /node --experimental-strip-types benchmarks\/scripts\/start-run\.mjs/);
		assert.match(text, /benchmarks\/scripts\/start-run\.mjs/);
		assert.doesNotMatch(text, /Run from the root of the `pi-subagents` checkout under test/);
	});

	it("refuses to contaminate an existing session", async () => {
		const h = harness([{ type: "message", message: { role: "user", content: "already used" } }]);
		await h.command().handler("", h.ctx as never);
		assert.equal(h.sent(), undefined);
		assert.equal(h.notifications.some((message) => message.includes("fresh Pi session")), true);
	});
});
