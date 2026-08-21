import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerFullSubagentExtension from "./index.ts";
import {
	BasicSubagentParams,
	BASIC_SUBAGENT_PROMPT_SNIPPET,
	BASIC_SUBAGENT_TOOL_DESCRIPTION,
	SUBAGENT_CAPABILITY_DESCRIPTION,
	SUBAGENT_CAPABILITY_TOOL_NAME,
	SUBAGENT_TOOL_NAME,
	SUBAGENT_WAIT_TOOL_NAME,
	SubagentCapabilityParams,
} from "./context-surface-contract.ts";

type BasicSubagentInput = {
	action?: "list";
	agent?: string;
	task?: string;
	calls?: Array<{ agent: string; task: string }>;
	async?: boolean;
	context?: "fresh" | "fork" | "profile";
	cwd?: string;
	model?: string;
	worktree?: boolean;
	timeoutMs?: number;
};

type CapabilityMode = "advanced" | "wait" | "all" | "minimal";

function buildParallelWorkflowScript(calls: Array<{ agent: string; task: string }>): string {
	const items = calls.map((call, index) => ({
		key: `call-${index + 1}`,
		agent: call.agent,
		task: call.task,
	}));
	return `return await runs.all(${JSON.stringify(items)});`;
}

function translateBasicParams(params: BasicSubagentInput): Record<string, unknown> {
	if (!params.calls) return { ...params };
	const { calls, action: _action, agent: _agent, task: _task, ...defaults } = params;
	return {
		...defaults,
		workflowScript: buildParallelWorkflowScript(calls),
	};
}

function validateBasicParams(params: BasicSubagentInput): string | undefined {
	const hasSingleField = params.agent !== undefined || params.task !== undefined;
	const hasCalls = params.calls !== undefined;

	if (params.action !== undefined) {
		if (params.action !== "list") return `Unsupported minimal subagent action: ${params.action}`;
		if (hasSingleField || hasCalls) return "action cannot be combined with agent/task or calls.";
		return undefined;
	}
	if (hasCalls && hasSingleField) return "Use either agent/task or calls, not both.";
	if (hasCalls) return params.calls!.length > 0 ? undefined : "calls must contain at least one child.";
	if ((params.agent === undefined) !== (params.task === undefined)) return "agent and task must be provided together.";
	if (params.agent === undefined) return "Provide agent/task for one child, calls for parallel children, or action:'list'.";
	return undefined;
}

/**
 * Progressive-disclosure wrapper for the parent-facing model tool surface.
 *
 * The full pi-subagents runtime still initializes exactly as before. During
 * registration we capture the large model-facing contracts and expose a small
 * contract for the common single-child and parallel-fanout paths. The original
 * full tool is restored on demand, so advanced behavior is not reimplemented.
 */
export default function registerContextOptimizedSubagentExtension(pi: ExtensionAPI): void {
	let fullSubagentTool: ToolDefinition | undefined;
	let basicSubagentTool: ToolDefinition | undefined;
	let waitTool: ToolDefinition | undefined;

	const originalRegisterTool = pi.registerTool.bind(pi) as (tool: ToolDefinition) => void;
	const mutablePi = pi as ExtensionAPI & { registerTool: (tool: ToolDefinition) => void };

	const interceptedRegisterTool = (tool: ToolDefinition): void => {
		if (tool.name === SUBAGENT_TOOL_NAME) {
			fullSubagentTool = tool;
			basicSubagentTool = {
				...tool,
				name: SUBAGENT_TOOL_NAME,
				label: "Subagent",
				description: BASIC_SUBAGENT_TOOL_DESCRIPTION,
				promptSnippet: BASIC_SUBAGENT_PROMPT_SNIPPET,
				promptGuidelines: undefined,
				parameters: BasicSubagentParams,
				constrainedSampling: false,
				prepareArguments: undefined,
				async execute(id, params, signal, onUpdate, ctx) {
					const basic = params as BasicSubagentInput;
					const error = validateBasicParams(basic);
					if (error) {
						return {
							content: [{ type: "text", text: error }],
							details: { mode: "single", results: [] },
							isError: true,
						};
					}
					return tool.execute(
						id,
						translateBasicParams(basic) as never,
						signal,
						onUpdate as never,
						ctx,
					);
				},
				...(tool.renderCall ? {
					renderCall(args, theme, context) {
						return tool.renderCall!(
							translateBasicParams(args as BasicSubagentInput) as never,
							theme,
							context as never,
						);
					},
				} : {}),
			} as ToolDefinition;
			originalRegisterTool(basicSubagentTool);
			return;
		}

		if (tool.name === SUBAGENT_WAIT_TOOL_NAME) {
			waitTool = tool;
			// Do not register this large contract until it is actually requested.
			return;
		}

		originalRegisterTool(tool);
	};

	// Pi's ExtensionAPI is a mutable runtime object. Intercept registration only
	// during the existing extension's synchronous setup, then restore it so the
	// original runtime keeps the exact same `pi` identity and behavior.
	mutablePi.registerTool = interceptedRegisterTool as typeof pi.registerTool;
	try {
		registerFullSubagentExtension(pi);
	} finally {
		mutablePi.registerTool = originalRegisterTool as typeof pi.registerTool;
	}

	const removeActiveTool = (name: string): void => {
		const active = pi.getActiveTools();
		if (!active.includes(name)) return;
		pi.setActiveTools(active.filter((candidate) => candidate !== name));
	};

	const addActiveTool = (name: string): void => {
		const active = pi.getActiveTools();
		if (active.includes(name)) return;
		pi.setActiveTools([...active, name]);
	};

	const restoreMinimalSurface = (): void => {
		if (basicSubagentTool) originalRegisterTool(basicSubagentTool);
		removeActiveTool(SUBAGENT_WAIT_TOOL_NAME);
	};

	const capabilityTool: ToolDefinition<typeof SubagentCapabilityParams, { mode: CapabilityMode }> = {
		name: SUBAGENT_CAPABILITY_TOOL_NAME,
		label: "Subagent Capability",
		description: SUBAGENT_CAPABILITY_DESCRIPTION,
		promptSnippet: "Load advanced subagent controls only when the minimal subagent tool cannot express the task.",
		parameters: SubagentCapabilityParams,
		async execute(_id, params) {
			if (params.mode === "minimal") {
				restoreMinimalSurface();
				return {
					content: [{ type: "text", text: "Restored the minimal subagent surface." }],
					details: { mode: params.mode },
				};
			}

			if (params.mode === "advanced" || params.mode === "all") {
				if (!fullSubagentTool) {
					return {
						content: [{ type: "text", text: "The advanced subagent contract is unavailable." }],
						details: { mode: params.mode },
						isError: true,
					};
				}
				originalRegisterTool(fullSubagentTool);
			}

			if (params.mode === "wait" || params.mode === "all") {
				if (!waitTool) {
					return {
						content: [{ type: "text", text: "subagent_wait is unavailable." }],
						details: { mode: params.mode },
						isError: true,
					};
				}
				originalRegisterTool(waitTool);
				addActiveTool(SUBAGENT_WAIT_TOOL_NAME);
			}

			const text = params.mode === "advanced"
				? "Loaded the full subagent contract for this parent turn."
				: params.mode === "wait"
					? "Loaded subagent_wait for this parent turn."
					: "Loaded the full subagent contract and subagent_wait for this parent turn.";
			return {
				content: [{ type: "text", text }],
				details: { mode: params.mode },
			};
		},
	};
	pi.registerTool(capabilityTool);

	// Advanced schemas should never become a permanent tax on later requests.
	pi.on("session_start", restoreMinimalSurface);
	pi.on("agent_end", restoreMinimalSurface);
}
