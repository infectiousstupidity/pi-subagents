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

		assert.ok(basicBytes < 2_500, `basic schema grew to ${basicBytes} bytes`);
		assert.ok(
			basicBytes * 4 < fullBytes,
			`basic schema (${basicBytes} bytes) should stay below 25% of full schema (${fullBytes} bytes)`,
		);
	});

	it("does not leak advanced workflow fields into the default contract", () => {
		const schema = JSON.stringify(BasicSubagentParams);
		assert.doesNotMatch(schema, /workflowScript/);
		assert.doesNotMatch(schema, /mission/);
		assert.doesNotMatch(schema, /schedule/);
		assert.doesNotMatch(schema, /acceptance/);
		assert.doesNotMatch(schema, /watchdog/);
	});

	it("keeps fixed model-facing guidance bounded", () => {
		assert.ok(Buffer.byteLength(BASIC_SUBAGENT_TOOL_DESCRIPTION) < 600);
		assert.ok(bytes(SubagentCapabilityParams) < 700);
		assert.ok(Buffer.byteLength(SUBAGENT_CAPABILITY_DESCRIPTION) < 180);
	});

	it("registers the small package surface first and restores the original full contract on demand", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-context-surface-"));
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_SUBAGENT_CHILD;

		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const registered = new Map();
			let activeTools = ["read", "bash", "edit", "write", "subagent", "subagent_capability"];
			const events = { on() { return () => {}; }, emit() {} };
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registered.set(tool.name, tool); },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
				getActiveTools() { return activeTools; },
				setActiveTools(next) { activeTools = [...next]; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});

			registerSubagentExtension(fakePi);
			const initial = registered.get("subagent");
			const capability = registered.get("subagent_capability");
			if (!initial || !capability) throw new Error("optimized tools were not registered");
			const initialProperties = Object.keys(initial.parameters.properties ?? {});
			const waitInitiallyRegistered = registered.has("subagent_wait");
			await capability.execute("capability-test", { mode: "advanced" }, undefined, undefined, undefined);
			const advanced = registered.get("subagent");
			const advancedProperties = Object.keys(advanced.parameters.properties ?? {});
			process.stdout.write(JSON.stringify({ initialProperties, waitInitiallyRegistered, advancedProperties }));
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
			advancedProperties: string[];
		};

		assert.equal(result.waitInitiallyRegistered, false);
		assert.equal(result.initialProperties.includes("workflowScript"), false);
		assert.equal(result.initialProperties.includes("mission"), false);
		assert.equal(result.advancedProperties.includes("workflowScript"), true);
		assert.equal(result.advancedProperties.includes("mission"), true);
	});
});
