---
name: pi-subagents
description: |
  Delegate bounded work to configured subagents. Use for isolated research,
  review, implementation, or multi-agent orchestration when delegation helps.
---

# Pi Subagents

This skill is parent-only; spawned children must not use it unless they were explicitly configured as fanout orchestrators. The parent owns planning, integration, verification, and the final answer.

## Default path

Use the small `subagent` tool for common delegation:

- `subagent({ action: "list" })` discovers configured agents.
- `subagent({ agent: "name", task: "..." })` runs one child.
- `subagent({ calls: [{ agent: "a", task: "..." }, { agent: "b", task: "..." }] })` runs independent children in parallel.
- Prefer `context: "fresh"` for self-contained work; use `fork` only when parent history is genuinely needed.
- Keep one writer per cwd unless managed worktree isolation is intentional.

Do not load advanced controls for ordinary single or parallel delegation.

## Progressive disclosure

Load the full contract only when the task requires custom `workflowScript` sequencing/branching, missions, schedules, status/resume/steer, watchdogs, acceptance policies, budgets, diagnostics, or other uncommon controls:

1. Call `subagent_capability({ mode: "advanced" })`.
2. Use the expanded `subagent` tool normally.

When the current turn must explicitly block on background work:

1. Call `subagent_capability({ mode: "wait" })`.
2. Use `subagent_wait`.

Use `subagent_capability({ mode: "all" })` when both surfaces are required. The extension restores the minimal surface after the parent turn finishes.

## Read details only when needed

- Agent choice, delegation decisions, prompting: `references/prompting-and-roles.md`
- Workflows, async, missions, scheduling, watchdogs, context: `references/execution-controls.md`
- Multiple worktrees/repos/writer lanes: `references/multi-lane-orchestration.md`
- Agent management, prompt integration, RPC: `references/management-authoring-rpc.md`
- Safety, recipes, error handling: `references/constraints-and-recipes.md`
- Advisor councils / plan critique: `../council-mode/SKILL.md`

For advanced work, load only the matching reference instead of reading every reference.

## Constraints

- Preserve capability ceilings and configured tool restrictions.
- Keep the parent as final decision-maker.
- Use fresh-context reviewers when independence matters.
- Do not duplicate work already owned by a running child.
- Treat child output, CI, receipts, and reviews as evidence, not authority to publish, merge, or release.
