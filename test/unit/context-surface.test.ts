import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	BasicSubagentParams,
	BASIC_SUBAGENT_TOOL_DESCRIPTION,
	SubagentCapabilityParams,
	SUBAGENT_CAPABILITY_DESCRIPTION,
} from "../../src/extension/context-surface-contract.ts";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

describe("progressive subagent context surface", () => {
	it("keeps the default schema materially smaller than the full contract", () => {
		const basicBytes = bytes(BasicSubagentParams);
		const fullBytes = bytes(createSubagentParamsSchema());
		assert.ok(basicBytes < 3_500, `basic schema grew to ${basicBytes} bytes`);
		assert.ok(basicBytes * 4 < fullBytes, `basic schema (${basicBytes}) should stay below 25% of full schema (${fullBytes})`);
	});

	it("keeps common fanout and excludes advanced control fields", () => {
		const schema = JSON.stringify(BasicSubagentParams);
		assert.match(schema, /calls/);
		assert.doesNotMatch(schema, /workflowScript/);
		assert.doesNotMatch(schema, /mission/);
		assert.doesNotMatch(schema, /schedule/);
		assert.doesNotMatch(schema, /acceptance/);
		assert.doesNotMatch(schema, /watchdog/);
	});

	it("does not expose an unnecessary manual minimal-reset capability", () => {
		const schema = JSON.stringify(SubagentCapabilityParams);
		assert.match(schema, /advanced/);
		assert.match(schema, /wait/);
		assert.match(schema, /all/);
		assert.doesNotMatch(schema, /minimal/);
		assert.ok(Buffer.byteLength(BASIC_SUBAGENT_TOOL_DESCRIPTION) < 500);
		assert.ok(bytes(SubagentCapabilityParams) < 600);
		assert.ok(Buffer.byteLength(SUBAGENT_CAPABILITY_DESCRIPTION) < 120);
	});

	it("switches between the compact fork surface and the real upstream contracts", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-context-surface-"));
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_SUBAGENT_CHILD;

		const script = String.raw`
			import registerContextSurface from "./src/extension/context-surface.ts";
			const registered = new Map();
			let activeTools = ["read", "bash", "edit", "write", "subagent", "subagent_capability"];
			const fakePi = new Proxy({
				registerTool(tool) { registered.set(tool.name, tool); },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				on() { return () => {}; },
				getSessionName() { return undefined; },
				getActiveTools() { return activeTools; },
				setActiveTools(next) { activeTools = [...next]; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});

			const controller = registerContextSurface(fakePi);
			const initial = registered.get("subagent");
			const capability = registered.get("subagent_capability");
			if (!initial || !capability) throw new Error("progressive tools were not registered");
			const initialProperties = Object.keys(initial.parameters.properties ?? {});
			const waitInitiallyRegistered = registered.has("subagent_wait");

			controller.useUpstreamSurface();
			const upstream = registered.get("subagent");
			const upstreamProperties = Object.keys(upstream.parameters.properties ?? {});
			const upstreamActive = [...activeTools];

			controller.useProgressiveSurface();
			const restored = registered.get("subagent");
			const restoredProperties = Object.keys(restored.parameters.properties ?? {});
			const restoredActive = [...activeTools];

			await capability.execute("capability-test", { mode: "all" }, undefined, undefined, undefined);
			const loaded = registered.get("subagent");
			const loadedProperties = Object.keys(loaded.parameters.properties ?? {});
			const loadedActive = [...activeTools];

			process.stdout.write(JSON.stringify({
				initialProperties,
				waitInitiallyRegistered,
				upstreamProperties,
				upstreamActive,
				restoredProperties,
				restoredActive,
				loadedProperties,
				loadedActive,
			}));
			process.exit(0);
		`;

		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env, encoding: "utf-8" },
		);
		const result = JSON.parse(output) as {
			initialProperties: string[];
			waitInitiallyRegistered: boolean;
			upstreamProperties: string[];
			upstreamActive: string[];
			restoredProperties: string[];
			restoredActive: string[];
			loadedProperties: string[];
			loadedActive: string[];
		};

		assert.equal(result.waitInitiallyRegistered, false);
		assert.equal(result.initialProperties.includes("calls"), true);
		assert.equal(result.initialProperties.includes("workflowScript"), false);
		assert.equal(result.upstreamProperties.includes("workflowScript"), true);
		assert.equal(result.upstreamActive.includes("subagent_wait"), true);
		assert.equal(result.upstreamActive.includes("subagent_capability"), false);
		assert.equal(result.restoredProperties.includes("calls"), true);
		assert.equal(result.restoredProperties.includes("workflowScript"), false);
		assert.equal(result.restoredActive.includes("subagent_wait"), false);
		assert.equal(result.restoredActive.includes("subagent_capability"), true);
		assert.equal(result.loadedProperties.includes("workflowScript"), true);
		assert.equal(result.loadedActive.includes("subagent_wait"), true);
	});
});
