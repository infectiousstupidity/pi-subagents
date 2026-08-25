# pi-subagents benchmark v3

Purpose: detect regressions in the fork's **startup context tax, compact delegation, progressive disclosure, and async/wait path**.

This benchmark intentionally does not test coding quality, filesystem editing, acceptance machinery, reviewer quality, or general agent intelligence. Those belong in normal tests, not this benchmark.

## Rules

- Run `/bench-subagent` in a fresh Pi session. The command performs a tiny clean-context probe before this specification is injected.
- The Pi session may run from any cwd; `/bench-subagent` resolves the installed package root.
- Use `context: "fresh"` for every child.
- Every synchronous scenario explicitly uses `async: false`. Only the async scenario uses `async: true`.
- The parent orchestrates only. Do not solve child tasks yourself.
- **Fail forward:** if a benchmark call fails, continue to the next phase. Do not retry, inspect, repair, or diagnose during the measured core.
- Do not load advanced controls before Phase 3.
- Use the exact markers and generated workflowScript below. Markers keep outputs short and make calls easy to locate; PASS/FAIL uses runtime result state rather than exact model wording.
- The intended budget is **4 parent `subagent` calls and 5 child runs total**.

Generated results belong under `~/.pi/benchmarks/pi-subagents/`, not in the repository.

## Phase 0 — initialize + static context checks

Run exactly:

```bash
node --experimental-strip-types benchmarks/scripts/start-run.mjs
```

Keep the returned `runId` and `workflowScript`. Do not rewrite the workflowScript.

The script measures the shipped compact/full contracts and records repository provenance. `package-lock.json`, docs, tests, README, and changelog dirtiness are recorded but do not invalidate a baseline because they do not change the runtime being benchmarked.

## Phase 1 — compact single

Use compact `subagent` exactly once:

- `agent: "scout"`
- `context: "fresh"`
- `async: false`
- task:

```text
[BENCH:SINGLE] Return exactly BENCH_SINGLE=ok and nothing else.
```

## Phase 2 — compact parallel calls[]

Use one compact `subagent` call with:

- `context: "fresh"`
- `async: false`
- exactly two `scout` children in `calls[]`:

```text
[BENCH:PARALLEL:A] Return exactly BENCH_PARALLEL_A=ok and nothing else.
[BENCH:PARALLEL:B] Return exactly BENCH_PARALLEL_B=ok and nothing else.
```

## Phase 3 — advanced load/run/restore

Load advanced controls exactly once:

```text
subagent_capability({ mode: "advanced" })
```

Use one advanced `subagent` call with:

- `context: "fresh"`
- `async: false`
- `workflowScript`: the exact `workflowScript` returned by Phase 0

Do not rewrite or regenerate the script.

Then always restore minimal mode:

```text
subagent_capability({ mode: "minimal" })
```

The benchmark extension records the actual active model-facing tool surface after both capability calls. No extra child run is needed to prove restoration.

## Phase 4 — async + wait + final restore

Launch compact `subagent` exactly once:

- `agent: "scout"`
- `context: "fresh"`
- `async: true`
- task:

```text
[BENCH:ASYNC] Return exactly BENCH_ASYNC=ready and nothing else.
```

Load only wait:

```text
subagent_capability({ mode: "wait" })
```

Call exactly:

```text
subagent_wait({ all: true, timeoutMs: 120000 })
```

Then restore minimal mode:

```text
subagent_capability({ mode: "minimal" })
```

The benchmark extension records the wait-loaded and final-minimal tool surfaces directly.

## Phase 5 — collect measured core

Run exactly:

```bash
node benchmarks/scripts/collect-session.mjs <runId>
```

Do not diagnose failures before collection. The collector checks:

- that the clean probe completed and produced usage,
- compact/full static surface,
- successful single delegation,
- successful parallel `calls[]`,
- advanced workflow execution,
- advanced → minimal restoration,
- async completion observed through wait,
- final minimal restoration,
- exact capability sequence,
- unexpected/retry subagent calls.

Parent tokens, child tokens, and wall time are recorded only as informational trend data.

## Phase 6 — finalize

Run exactly:

```bash
node benchmarks/scripts/finalize-run.mjs <runId>
```

Finish by reporting only:

- run id and status,
- scenarios passed/total,
- clean probe tokens,
- pi-subagents model-facing tool-definition bytes,
- minimal/full schema bytes and ratio,
- capability sequence and extra subagent calls,
- parent tokens, nested tokens, and wall time as informational values,
- relevant dirty-worktree status,
- `RESULTS.md` and this run's `report.md`.

## Regression policy

Hard failure:

- any deterministic scenario fails,
- clean probe response/usage cannot be found,
- minimal schema is >= 3,500 bytes,
- minimal schema is >= 25% of full schema,
- `calls[]` is unavailable,
- `subagent_wait` is active in the initial minimal surface,
- generated advanced workflowScript is changed,
- capability sequence is not exactly `advanced → minimal → wait → minimal`,
- the core uses more or fewer than 4 parent `subagent` calls,
- wait is not called exactly once,
- the parent session cannot be identified.

Warning:

- runtime/benchmark source files are dirty,
- minimal schema bytes increase by >5% versus the previous comparable clean PASS,
- initial pi-subagents model-facing tool-definition bytes increase by >5% versus the previous comparable clean PASS.

Informational only — never changes status:

- exact child wording,
- clean probe token variation,
- parent token variation,
- nested child token variation,
- wall-time variation,
- dirtiness limited to package-lock, docs, tests, README, changelog, or .gitignore.

Only compare performance/context deltas when benchmark version, Pi version, provider, and model match. Static schema limits remain absolute.
