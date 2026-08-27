---
name: pi-subagents
description: Delegate work to child AI agents with isolated context. Use for delegation, parallel research, plan-then-execute workflows, and multi-agent orchestration.
---

# Pi Subagents

Delegate to child agents with the `subagent` tool.

## Use the Progressive-Disclosure Surfaces

The extension injects compact guidance plus a generated `## Agents` catalog into the system prompt. Treat that catalog as the source of truth for available agent names and descriptions.

Do not read `agents/*.md` just to discover agents. Load agent prompt files only when you need their implementation details.

## Single

```json
{"agent":"scout","task":"Find auth logic and summarize files"}
```

Use background execution only for independent work. In `single` and `parallel` modes, set `background: true`.

## Parallel

```json
{"tasks":[
  {"agent":"scout","task":"Trace caching logic"},
  {"agent":"researcher","task":"Check current caching guidance"}
]}
```

Parallel results preserve task order. The default concurrency limit is 4.

## Chain

Use `{previous}` to pass the previous step's output into the next step.

```json
{"chain":[
  {"agent":"scout","task":"Locate auth code"},
  {"agent":"planner","task":"Design a fix from: {previous}"},
  {"agent":"worker","task":"Implement: {previous}"}
]}
```

Do not set `background` in chain mode.

## Non-Interactive Subagents

Child agents cannot answer interactive questions. Give them complete tasks up front.

For repo-local tasks, provide paths, constraints, expected output, and any facts already known from the parent session. Do not assume child agents inherit parent context.

## External CLI Agents

External CLI agents run through the configured runner contract. Do not pass Pi-native child-agent options (for example `turnBudget`) unless that runner explicitly supports them.

## Common Errors

- Unknown agent: choose a name from the injected `## Agents` catalog.
- Invalid parameters: use exactly one mode: `agent` + `task`, `tasks`, or `chain`.
- Chain prompt bug: ensure later chain steps include `{previous}` when they depend on earlier output.
- Background misuse: use it only for `single` or `parallel`.
