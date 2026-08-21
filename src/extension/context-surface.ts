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
	waitToolIsConfiguredDisabled,
} from "./context-surface-contract.ts";

/**
 * Progressive-disclosure wrapper for the parent-facing model tool surface.
 *
 * The full pi-subagents runtime still initializes exactly as before. During
 * registration we capture the large model-facing contracts, expose a small
 * one-child `subagent` contract by default, and restore the full contract only
 * when the model explicitly asks for it through `subagent_capability`.
 *
 * This keeps workflow, mission, scheduling, watchdog, steering, acceptance,
 * worktree, and diagnostic functionality intact without paying for their
 * schemas and instructions on every ordinary model turn.
 */
export default function registerContextOptimizedSubagentExtension(pi: ExtensionAPI): void {
	let fullSubagentTool: ToolDefinition | undefined;
	let basicSubagentTool: ToolDefinition | undefined;
	let waitTool: ToolDefinition | undefined;
	let waitToolEnabled = false;

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
			} as ToolDefinition;
			originalRegisterTool(basicSubagentTool);
			return;
		}

		if (tool.name === SUBAGENT_WAIT_TOOL_NAME) {
			waitTool = tool;
			waitToolEnabled = !waitToolIsConfiguredDisabled(tool.description);
			// Do not register this large contract until it is actually needed.
			return;
		}

		originalRegisterTool(tool);
	};

	// ExtensionAPI is a mutable plain object. Intercept registration only while
	// the existing runtime initializes, then restore the original method so all
	// later runtime registrations keep normal Pi behavior and object identity.
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

	pi.registerTool({
		name: SUBAGENT_CAPABILITY_TOOL_NAME,
		label: "Subagent Capability",
		description: SUBAGENT_CAPABILITY_DESCRIPTION,
		promptSnippet: "Load the full subagent contract only for advanced orchestration or explicit waiting.",
		parameters: SubagentCapabilityParams,
		async execute(_id, params) {
			if (params.mode === "minimal") {
				restoreMinimalSurface();
				return {
					content: [{ type: "text", text: "Restored the minimal subagent tool surface." }],
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
				if (!waitTool || !waitToolEnabled) {
					return {
						content: [{ type: "text", text: "subagent_wait is disabled by configuration." }],
						details: { mode: params.mode },
						isError: true,
					};
				}
				originalRegisterTool(waitTool);
				addActiveTool(SUBAGENT_WAIT_TOOL_NAME);
			}

			const text = params.mode === "advanced"
				? "Loaded the full subagent workflow/control contract for this turn."
				: params.mode === "wait"
					? "Loaded subagent_wait for this turn."
					: "Loaded the full subagent contract and subagent_wait for this turn.";
			return {
				content: [{ type: "text", text }],
				details: { mode: params.mode },
			};
		},
	});

	// A new session and each completed parent turn return to the cheap surface.
	// Advanced functionality remains available through one tiny capability call.
	pi.on("session_start", () => {
		restoreMinimalSurface();
	});
	pi.on("agent_end", () => {
		restoreMinimalSurface();
	});
}
