# pi-subagents benchmark v1

Purpose: detect regressions in the fork's **default context cost, common delegation paths, progressive disclosure, correctness, and orchestration discipline**.

This benchmark is intentionally boring. Follow the phases exactly. Do not optimize the benchmark itself during a run.

## Rules

- Run from the root of the `pi-subagents` checkout under test.
- A fresh Pi session is required. `/bench-subagent` must be the first user request.
- `start-run.mjs` creates the disposable benchmark workspace. Do not alter it except through the instructed worker phases.
- Do not use advanced subagent controls before Phase 4.
- Use `context: "fresh"` for benchmark children unless a phase says otherwise.
- The parent orchestrates only. Do not solve child tasks yourself.
- Do not retry a failed benchmark phase unless the tool/runtime itself failed transiently. Record the failure instead.
- Use the exact benchmark markers below; the collector finds them in the saved Pi JSONL session.

Generated data belongs under `~/.pi/benchmarks/pi-subagents/`, not in the repository.

## Phase 0 — initialize and static checks

Run exactly one preflight command:

```bash
node --experimental-strip-types benchmarks/scripts/start-run.mjs
```

It creates the disposable fixture, records exact compact/full schema metrics, and runs the dedicated context-surface unit test. Keep the returned `runId`, `runDir`, and `workspace` paths for the rest of the benchmark.

Do not invoke a subagent before this command finishes.

## Phase 1 — minimal single child

Use the compact `subagent` surface once:

- agent: `scout`
- context: `fresh`
- task:

```text
[BENCH:SINGLE] Read <workspace>/facts/alpha.txt. Return exactly BENCH_SINGLE=17 and nothing else.
```

Do not load advanced controls.

## Phase 2 — minimal parallel fanout

Use one compact `subagent` call with `calls[]` containing exactly these three independent children, all using `scout`:

```text
[BENCH:PARALLEL:A] Read <workspace>/facts/alpha.txt. Return exactly BENCH_PARALLEL_A=17 and nothing else.
[BENCH:PARALLEL:B] Read <workspace>/facts/beta.txt. Return exactly BENCH_PARALLEL_B=23 and nothing else.
[BENCH:PARALLEL:C] Read <workspace>/facts/gamma.txt. Return exactly BENCH_PARALLEL_C=41 and nothing else.
```

Use shared `context: "fresh"`. Do not load advanced controls.

## Phase 3 — minimal worker edit

Use the compact `subagent` surface once:

- agent: `worker`
- context: `fresh`
- task:

```text
[BENCH:WORKER] In <workspace>/code, fix normalize.mjs so all tests in test/normalize.test.mjs pass. Do not modify the test file. Run the tests before finishing. Make the smallest correct change.
```

After the child finishes, the parent must run this deterministic check:

```bash
node --test <workspace>/code/test/normalize.test.mjs
```

Do not fix the code yourself if the child failed.

## Phase 4 — advanced workflow, then unload it

Load advanced controls exactly once:

```text
subagent_capability({ mode: "advanced" })
```

Then use the advanced `subagent` tool with one `workflowScript` that performs exactly this sequence:

1. `scout` reads `<workspace>/facts/workflow-seed.txt` and returns only the integer. Mark the task `[BENCH:ADV:SCOUT]`.
2. Parse that integer.
3. `worker` writes **double that value plus a trailing newline** to `<workspace>/derived.txt`. Mark the task `[BENCH:ADV:WORKER]`.
4. Return the worker result.

Use `runs.run` for the sequential children. The expected file is exactly:

```text
38
```

After the workflow finishes, explicitly restore the compact surface:

```text
subagent_capability({ mode: "minimal" })
```

The collector later verifies `derived.txt` byte-for-byte. Do not repair it in the parent if the workflow failed.

## Phase 5 — async + wait, then unload wait

Using the compact `subagent` surface, launch one background child:

- agent: `scout`
- async: `true`
- context: `fresh`
- task:

```text
[BENCH:ASYNC] Read <workspace>/facts/async.txt. Return exactly BENCH_ASYNC=ready and nothing else.
```

Load only the wait surface:

```text
subagent_capability({ mode: "wait" })
```

Use `subagent_wait` with `{ all: true, timeoutMs: 120000 }` so this benchmark remains run-to-completion.

Then explicitly restore the compact surface:

```text
subagent_capability({ mode: "minimal" })
```

## Phase 6 — prove compact surface still works

Use one compact `subagent` call with `calls[]` containing exactly two `scout` children:

```text
[BENCH:RESTORE:A] Read <workspace>/facts/alpha.txt. Return exactly BENCH_RESTORE_A=17 and nothing else.
[BENCH:RESTORE:B] Read <workspace>/facts/beta.txt. Return exactly BENCH_RESTORE_B=23 and nothing else.
```

Use shared `context: "fresh"`.

Do not load advanced or wait again.

## Phase 7 — close the measured core and collect it

Run:

```bash
node benchmarks/scripts/collect-session.mjs <runId>
```

The collector marks `core-end` immediately when it starts, before it scans the session.

The collector must produce `metrics.json` and print the exact Pi session path it found. If it cannot uniquely identify the current session, stop and report the benchmark as failed.

Everything after `core-end` is excluded from core token/time metrics.

## Phase 8 — independent session review

Now use the compact `calls[]` path one final time with **two fresh `reviewer` children in parallel**. Give both reviewers:

- the saved Pi session path printed by the collector,
- `<runDir>/metrics.json`,
- this `BENCHMARK.md` file.

Reviewer 1 task:

```text
[BENCH:REVIEW:EFFICIENCY] Audit only benchmark orchestration efficiency and progressive-disclosure discipline. Check for unnecessary capability loading, retries, duplicate work, parent-side task solving, or avoidable tool calls. Return exactly:
VERDICT: PASS|WARN|FAIL
FINDINGS:
- ...
```

Reviewer 2 task:

```text
[BENCH:REVIEW:CORRECTNESS] Audit whether the benchmark followed its specification and whether the session evidence supports the deterministic results. Look for skipped phases, cheating, task drift, hidden retries, or suspicious success claims. Return exactly:
VERDICT: PASS|WARN|FAIL
FINDINGS:
- ...
```

Write the two reviewer outputs verbatim to:

```text
<runDir>/review-efficiency.md
<runDir>/review-correctness.md
```

Do not synthesize or change their verdicts.

## Phase 9 — finalize

Run:

```bash
node benchmarks/scripts/finalize-run.mjs <runId>
```

This creates:

```text
~/.pi/benchmarks/pi-subagents/
├── RESULTS.md
└── runs/<runId>/
    ├── meta.json
    ├── static.json
    ├── metrics.json
    ├── review-efficiency.md
    ├── review-correctness.md
    ├── report.md
    └── workspace/
```

Finish by reporting only:

- run id,
- deterministic status,
- scenarios passed/total,
- first-turn usage,
- minimal/full schema bytes and ratio,
- core parent tokens,
- nested subagent tokens,
- core wall time,
- the two reviewer verdicts,
- path to `RESULTS.md`,
- path to this run's `report.md`.

## What counts as a regression

Hard failure:

- any deterministic scenario fails,
- the context-surface unit test fails,
- minimal schema is >= 3,500 bytes,
- minimal schema is >= 25% of the full schema,
- advanced controls are used before Phase 4,
- the required compact `calls[]` path is unavailable,
- the benchmark cannot identify its saved Pi session.

Warning:

- capability sequence is not exactly `advanced → minimal → wait → minimal`,
- extra `subagent` retries occur,
- either reviewer returns WARN,
- first-turn usage or core token usage materially increases versus a comparable prior run.

Do not compare token or wall-time numbers across different models/providers as if they were equivalent. Static schema metrics and deterministic scenario results are comparable across environments.
