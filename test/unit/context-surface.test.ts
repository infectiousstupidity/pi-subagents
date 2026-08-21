import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BasicSubagentParams,
	BASIC_SUBAGENT_TOOL_DESCRIPTION,
	SubagentCapabilityParams,
	SUBAGENT_CAPABILITY_DESCRIPTION,
} from "../../src/extension/context-surface-contract.ts";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";

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
});
