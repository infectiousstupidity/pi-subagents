import { Type } from "typebox";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_WAIT_TOOL_NAME = "subagent_wait";
export const SUBAGENT_CAPABILITY_TOOL_NAME = "subagent_capability";

/**
 * Small parent-facing contract used for ordinary delegation.
 *
 * Keep this intentionally narrow. The full historical subagent schema is
 * captured by context-surface.ts and restored on demand via
 * subagent_capability({ mode: "advanced" }).
 */
export const BasicSubagentParams = Type.Object({
	action: Type.Optional(Type.String({
		enum: ["list"],
		description: "Use 'list' to discover configured agents. Omit for execution.",
	})),
	agent: Type.Optional(Type.String({ description: "Configured agent name for one-child execution." })),
	task: Type.Optional(Type.String({ description: "Task for the child. Requires agent." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background. Omitted uses configured default." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork", "profile"],
		description: "Child context: fresh, fork, or the agent profile default.",
	})),
	cwd: Type.Optional(Type.String({ description: "Child working directory." })),
	model: Type.Optional(Type.String({ description: "Optional child model override." })),
	worktree: Type.Optional(Type.Boolean({ description: "Use a managed git worktree for isolation." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional run timeout in milliseconds." })),
}, { additionalProperties: false });

export const BASIC_SUBAGENT_TOOL_DESCRIPTION =
	"Delegate one task to a configured subagent, or use action:'list' to discover agents. For workflowScript, missions, scheduling, status/resume/steer, debugging, budgets, or other advanced controls, first load the advanced surface with subagent_capability.";

export const BASIC_SUBAGENT_PROMPT_SNIPPET =
	"Use subagent for one-child delegation. Load advanced subagent controls only when the task requires them.";

export const SubagentCapabilityParams = Type.Object({
	mode: Type.String({
		enum: ["advanced", "wait", "all", "minimal"],
		description: "advanced loads the full subagent contract; wait loads subagent_wait; all loads both; minimal restores the small default surface.",
	}),
}, { additionalProperties: false });

export const SUBAGENT_CAPABILITY_DESCRIPTION =
	"Load advanced subagent or wait controls only when needed, or restore the minimal default surface.";

export function waitToolIsConfiguredDisabled(description: unknown): boolean {
	return typeof description === "string"
		&& description.includes("Configured behavior: subagent_wait is disabled");
}
