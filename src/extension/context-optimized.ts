import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Details } from "../shared/types.ts";
import registerFullSubagentExtension from "./index.ts";

const ADVANCED_TOOL = "subagent_advanced";
const WAIT_TOOL = "subagent_wait";
const CAPABILITY_TOOL = "subagent_capability";

const SimpleCallSchema = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	context: Type.Optional(Type.String({ enum: ["fresh", "fork", "profile"] })),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const MinimalSubagentParams = Type.Object({
	action: Type.Optional(Type.String({ enum: ["list"], description: "List configured agents." })),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Agent for one child." })),
	task: Type.Optional(Type.String({ description: "Task for one child." })),
	calls: Type.Optional(Type.Array(SimpleCallSchema, {
		minItems: 1,
		maxItems: 8,
		description: "Independent child calls to run in parallel.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Run in background. Omitted uses configured default." })),
	model: Type.Optional(Type.String()),
	context: Type.Optional(Type.String({ enum: ["fresh", "fork", "profile"] })),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const CapabilityParams = Type.Object({
	mode: Type.String({
		enum: ["advanced", "wait", "all", "minimal"],
		description: "Temporarily expose advanced controls, waiting, both, or restore the minimal surface.",
	}),
}, { additionalProperties: false });

type ToolLike = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	execute?: (...args: any[]) => Promise<any>;
	[key: string]: unknown;
};

function invalidRequest(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

function activeTools(pi: ExtensionAPI): string[] {
	return pi.getActiveTools();
}

function setDeferredSurface(pi: ExtensionAPI, mode: "advanced" | "wait" | "all" | "minimal"): string[] {
	const next = new Set(activeTools(pi));
	if (mode === "minimal") {
		next.delete(ADVANCED_TOOL);
		next.delete(WAIT_TOOL);
	} else {
		if (mode === "advanced" || mode === "all") next.add(ADVANCED_TOOL);
		if (mode === "wait" || mode === "all") next.add(WAIT_TOOL);
	}
	const tools = [...next];
	pi.setActiveTools(tools);
	return tools;
}

function restoreMinimalSurface(pi: ExtensionAPI): void {
	const current = activeTools(pi);
	const next = current.filter((name) => name !== ADVANCED_TOOL && name !== WAIT_TOOL);
	if (next.length !== current.length) pi.setActiveTools(next);
}

function buildWorkflowScript(calls: Array<Record<string, unknown>>): string {
	const items = calls.map((call, index) => ({ key: `call-${index + 1}`, ...call }));
	return `return runs.all(${JSON.stringify(items)})`;
}

function makeMinimalTool(original: ToolLike): ToolLike {
	return {
		...original,
		name: "subagent",
		label: "Subagent",
		description: "Delegate one task or a small parallel batch to configured subagents. Use action:'list' to discover agents. Load subagent_advanced through subagent_capability only for workflows or management.",
		promptSnippet: "Delegate bounded independent work with subagent; keep advanced controls unloaded unless needed.",
		promptGuidelines: [
			"Use subagent only when delegation helps. Use action:'list' when agent names are unknown.",
			"Use calls for ordinary parallel work. Load advanced controls only for custom workflows, lifecycle management, missions, schedules, diagnostics, or steering.",
		],
		parameters: MinimalSubagentParams,
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
			if (!original.execute) return invalidRequest("Subagent executor is unavailable.");

			if (params.calls !== undefined) {
				if (params.action !== undefined || params.agent !== undefined || params.task !== undefined) {
					return invalidRequest("Use either calls, agent/task, or action:'list', not more than one mode.");
				}
				if (!Array.isArray(params.calls) || params.calls.length === 0) {
					return invalidRequest("calls must contain at least one child request.");
				}
				if (params.calls.length === 1) {
					const [call] = params.calls;
					return original.execute(id, { ...call, ...(params.async !== undefined ? { async: params.async } : {}) }, signal, onUpdate, ctx);
				}
				return original.execute(id, {
					workflowScript: buildWorkflowScript(params.calls),
					...(params.async !== undefined ? { async: params.async } : {}),
				}, signal, onUpdate, ctx);
			}

			if (params.action !== undefined) {
				if (params.action !== "list" || params.agent !== undefined || params.task !== undefined) {
					return invalidRequest("The minimal surface supports only action:'list'. Load subagent_advanced for other management actions.");
				}
				return original.execute(id, { action: "list" }, signal, onUpdate, ctx);
			}

			return original.execute(id, params, signal, onUpdate, ctx);
		},
	};
}

function makeAdvancedTool(original: ToolLike): ToolLike {
	return {
		...original,
		name: ADVANCED_TOOL,
		label: "Subagent Advanced",
	};
}

function makeCapabilityTool(pi: ExtensionAPI): ToolLike {
	return {
		name: CAPABILITY_TOOL,
		label: "Subagent Capability",
		description: "Temporarily expose advanced subagent controls only when required.",
		promptSnippet: "Load advanced subagent tools on demand; prefer the minimal subagent tool.",
		parameters: CapabilityParams,
		async execute(_id: string, params: { mode: "advanced" | "wait" | "all" | "minimal" }) {
			const tools = setDeferredSurface(pi, params.mode);
			const exposed = [ADVANCED_TOOL, WAIT_TOOL].filter((name) => tools.includes(name));
			return {
				content: [{
					type: "text",
					text: exposed.length > 0
						? `Enabled for this turn: ${exposed.join(", ")}.`
						: "Restored the minimal subagent tool surface.",
				}],
				details: { mode: params.mode, active: exposed },
			};
		},
	};
}

/**
 * Wrap the full extension without changing its mature runtime. Only the
 * model-facing registration surface changes:
 * - subagent: small common-case schema
 * - subagent_advanced: original full schema, inactive by default
 * - subagent_wait: original wait tool, inactive by default
 * - subagent_capability: tiny progressive-disclosure loader
 */
export default function registerContextOptimizedSubagentExtension(pi: ExtensionAPI): void {
	const realRegisterTool = pi.registerTool.bind(pi);
	const proxy = new Proxy(pi as ExtensionAPI, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolLike) => {
					if (tool.name === "subagent") {
						realRegisterTool(makeMinimalTool(tool) as any);
						realRegisterTool(makeAdvancedTool(tool) as any);
						return;
					}
					realRegisterTool(tool as any);
				};
			}
			const value = Reflect.get(target as object, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	registerFullSubagentExtension(proxy);
	realRegisterTool(makeCapabilityTool(pi) as any);

	// Registration makes tools active in Pi. Remove the deferred schemas before
	// the first model turn and again after every parent turn.
	pi.on("session_start", () => restoreMinimalSurface(pi));
	pi.on("agent_end", () => restoreMinimalSurface(pi));
}
