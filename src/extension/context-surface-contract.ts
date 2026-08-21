import { Type } from "typebox";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_WAIT_TOOL_NAME = "subagent_wait";
export const SUBAGENT_CAPABILITY_TOOL_NAME = "subagent_capability";

const BasicSubagentCall = Type.Object({
	agent: Type.String({ description: "Configured agent name." }),
	task: Type.String({ description: "Task for this child." }),
}, { additionalProperties: false });

/**
 * Small parent-facing contract used for the common delegation paths.
 *
 * Keep this intentionally narrow. The full historical subagent schema is
 * captured by context-surface.ts and restored only when genuinely needed.
 */
export const BasicSubagentParams = Type.Object({
	action: Type.Optional(Type.String({
		enum: ["list"],
		description: "List configured agents. Omit for execution.",
	})),
	agent: Type.Optional(Type.String({ description: "Agent for one-child execution." })),
	task: Type.Optional(Type.String({ description: "Task for one-child execution. Requires agent." })),
	calls: Type.Optional(Type.Array(BasicSubagentCall, {
		minItems: 1,
		maxItems: 8,
		description: "Independent children to run in parallel. Use agent/task instead for one child.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Run in background. Omitted uses configured default." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork", "profile"],
		description: "Shared child context: fresh, fork, or agent profile default.",
	})),
	cwd: Type.Optional(Type.String({ description: "Shared child working directory." })),
	model: Type.Optional(Type.String({ description: "Shared child model override." })),
	worktree: Type.Optional(Type.Boolean({ description: "Use managed git worktree isolation." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional run timeout in milliseconds." })),
}, { additionalProperties: false });

export const BASIC_SUBAGENT_TOOL_DESCRIPTION =
	"Delegate one child with agent/task or independent parallel children with calls[]. Use action:'list' to discover agents. Load advanced controls only for uncommon orchestration or management.";

export const BASIC_SUBAGENT_PROMPT_SNIPPET =
	"Delegate ordinary single or parallel work with subagent; load advanced controls only when required.";

export const SubagentCapabilityParams = Type.Object({
	mode: Type.String({
		enum: ["advanced", "wait", "all", "minimal"],
		description: "Load advanced subagent controls, subagent_wait, both, or restore the minimal surface.",
	}),
}, { additionalProperties: false });

export const SUBAGENT_CAPABILITY_DESCRIPTION =
	"Temporarily load advanced subagent controls only when needed.";
