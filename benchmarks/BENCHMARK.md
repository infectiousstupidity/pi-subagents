# pi-subagents benchmark v2

Purpose: detect regressions in the fork's **clean starting context, compact tool surface, common delegation paths, progressive disclosure, correctness, and orchestration discipline**.

This benchmark is intentionally boring. Follow it exactly. Do not diagnose failures during the measured core.

## Rules

- `/bench-subagent` must be run in a fresh Pi session. The command performs a tiny clean-context probe before this specification is injected.
- The Pi session may run from any cwd; `/bench-subagent` resolves the installed package root.
- Phase 0 creates a disposable workspace under `~/.pi/benchmarks/pi-subagents/`.
- Every normally synchronous scenario explicitly uses `async: false`. Only Phase 5 uses `async: true`.
- Use `context: "fresh"` for benchmark children.
- The parent orchestrates only. Do not solve child tasks yourself.
- **Fail forward:** if a benchmark child/tool fails, record the failure and continue to the next phase. Do not retry, inspect, repair, or debug during the measured core.
- Do not load advanced controls before Phase 4.
- Use the exact markers below. The collector uses the saved Pi JSONL session as evidence.

Generated data belongs under `~/.pi/benchmarks/pi-subagents/`, not in the repository.

## Phase 0 — initialize + production static checks

Run exactly:

```bash
node --experimental-strip-types benchmarks/scripts/start-run.mjs
```

Keep the returned `runId`, `runDir`, `workspace`, and `workflowScriptPath`.

The script checks only shipped production contracts. Repository unit tests/CI are deliberately outside this benchmark.

## Phase 1 — compact single child

Use compact `subagent` exactly once:

- `agent: "scout"`
- `context: "fresh"`
- `async: false`
- task:

```text
[BENCH:SINGLE] Read <workspace>/facts/alpha.txt. Return exactly BENCH_SINGLE=17 and nothing else.
```

If it fails, continue without retrying.

## Phase 2 — compact parallel fanout

Use one compact `subagent` call with:

- `context: "fresh"`
- `async: false`
- `calls[]` with exactly three `scout` children:

```text
[BENCH:PARALLEL:A] Read <workspace>/facts/alpha.txt. Return exactly BENCH_PARALLEL_A=17 and nothing else.
[BENCH:PARALLEL:B] Read <workspace>/facts/beta.txt. Return exactly BENCH_PARALLEL_B=23 and nothing else.
[BENCH:PARALLEL:C] Read <workspace>/facts/gamma.txt. Return exactly BENCH_PARALLEL_C=41 and nothing else.
```

If it fails, continue without retrying.

## Phase 3 — compact worker edit

Use compact `subagent` exactly once:

- `agent: "worker"`
- `context: "fresh"`
- `async: false`
- task:

```text
[BENCH:WORKER] In <workspace>/code, fix normalize.mjs so all tests in test/normalize.test.mjs pass. Do not modify the test file. Run the tests before finishing. Make the smallest correct change.
```

Then run exactly:

```bash
node --test <workspace>/code/test/normalize.test.mjs
```

Do not repair the code in the parent if it fails.

## Phase 4 — exact advanced workflow, then unload

Load advanced controls exactly once:

```text
subagent_capability({ mode: "advanced" })
```

Read `<workflowScriptPath>`. Pass its contents **verbatim** as `workflowScript` to one advanced `subagent` call with:

- `context: "fresh"`
- `async: false`

Do not rewrite, regenerate, or "improve" the script.

The script itself performs the sequential scout → worker dependency and expects `<workspace>/derived.txt` to become exactly:

```text
38
```

After the workflow returns, always restore compact mode:

```text
subagent_capability({ mode: "minimal" })
```

If the workflow fails, do not investigate it during the core.

## Phase 5 — intentional async + wait, then unload wait

Launch compact `subagent`:

- `agent: "scout"`
- `context: "fresh"`
- `async: true`
- task:

```text
[BENCH:ASYNC] Read <workspace>/facts/async.txt. Return exactly BENCH_ASYNC=ready and nothing else.
```

Then load only wait:

```text
subagent_capability({ mode: "wait" })
```

Call:

```text
subagent_wait({ all: true, timeoutMs: 120000 })
```

Then always restore compact mode:

```text
subagent_capability({ mode: "minimal" })
```

Do not inspect the async run unless the benchmark specification explicitly says to.

## Phase 6 — compact surface still works

Use one compact `subagent` call with:

- `context: "fresh"`
- `async: false`
- exactly two `scout` children in `calls[]`:

```text
[BENCH:RESTORE:A] Read <workspace>/facts/alpha.txt. Return exactly BENCH_RESTORE_A=17 and nothing else.
[BENCH:RESTORE:B] Read <workspace>/facts/beta.txt. Return exactly BENCH_RESTORE_B=23 and nothing else.
```

Do not load advanced/wait again.

## Phase 7 — close measured core + collect

Run exactly:

```bash
node benchmarks/scripts/collect-session.mjs <runId>
```

The collector records the core end before analysis. It must produce `metrics.json` and print the exact parent session path.

Everything after core-end is excluded from measured core token/time metrics.

## Phase 8 — two independent reviewers

Use one final compact `subagent` call with:

- `context: "fresh"`
- `async: false`
- two parallel `reviewer` children.

Give both reviewers:

- the saved parent Pi session path,
- `<runDir>/metrics.json`,
- this benchmark specification embedded in the saved session.

Reviewer 1:

```text
[BENCH:REVIEW:EFFICIENCY] Audit benchmark orchestration efficiency and progressive-disclosure discipline only. Flag unnecessary capability loading, retries, duplicate work, parent-side task solving, diagnosis during the measured core, or avoidable tool calls. Return exactly:
VERDICT: PASS|WARN|FAIL
FINDINGS:
- ...
```

Reviewer 2:

```text
[BENCH:REVIEW:CORRECTNESS] Audit whether the benchmark followed its specification and whether session evidence supports the deterministic results. Flag skipped phases, cheating, task drift, hidden retries, rewritten workflowScript, or suspicious success claims. Return exactly:
VERDICT: PASS|WARN|FAIL
FINDINGS:
- ...
```

Write their outputs verbatim to:

```text
<runDir>/review-efficiency.md
<runDir>/review-correctness.md
```

## Phase 9 — finalize

Run exactly:

```bash
node benchmarks/scripts/finalize-run.mjs <runId>
```

Finish by reporting only:

- run id,
- status,
- scenarios passed/total,
- clean probe usage,
- clean estimated context,
- minimal/full schema bytes and ratio,
- core parent tokens,
- nested subagent tokens,
- core wall time,
- reviewer verdicts,
- `RESULTS.md`,
- this run's `report.md`.

## Regression policy

Hard failure:

- any deterministic scenario fails,
- clean probe does not return exactly `BENCH_PROBE_OK`,
- minimal schema is >= 3,500 bytes,
- minimal schema is >= 25% of full schema,
- compact `calls[]` is unavailable,
- advanced workflowScript differs from the generated exact script,
- benchmark cannot identify its saved parent session.

Warning:

- capability sequence is not exactly `advanced → minimal → wait → minimal`,
- core contains extra subagent calls/retries,
- either reviewer returns WARN,
- clean probe usage or core usage materially increases versus a comparable v2 run.

Only compare token/time numbers when benchmark version, Pi version, provider, and model match. Static schema metrics remain comparable across environments.
