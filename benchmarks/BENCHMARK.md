# pi-subagents benchmark v4

Measure only startup context tax, compact delegation, progressive disclosure, and async/wait.

Follow this exactly. Use `context: "fresh"` for every child. Use `async: false` unless explicitly told otherwise. If any call fails, continue without retrying, inspecting, repairing, or diagnosing. Do not add extra subagent calls.

Budget: **4 parent `subagent` calls / 5 child runs**.

## 0. Start

Run:

```bash
node --experimental-strip-types benchmarks/scripts/start-run.mjs
```

Keep the returned `runId` and `workflowScript` exactly as returned.

## 1. Compact single

Call compact `subagent` once:

```text
agent: scout
context: fresh
async: false
task: [BENCH:SINGLE] Return exactly BENCH_SINGLE=ok and nothing else.
```

## 2. Compact parallel

Call compact `subagent` once with `context: "fresh"`, `async: false`, and exactly these two `calls[]` children:

```text
scout: [BENCH:PARALLEL:A] Return exactly BENCH_PARALLEL_A=ok and nothing else.
scout: [BENCH:PARALLEL:B] Return exactly BENCH_PARALLEL_B=ok and nothing else.
```

## 3. Advanced

Call:

```text
subagent_capability({ mode: "advanced" })
```

Then call advanced `subagent` once with `context: "fresh"`, `async: false`, and the exact `workflowScript` returned in step 0. Do not rewrite it.

Then call:

```text
subagent_capability({ mode: "minimal" })
```

## 4. Async + wait

Call compact `subagent` once:

```text
agent: scout
context: fresh
async: true
task: [BENCH:ASYNC] Return exactly BENCH_ASYNC=ready and nothing else.
```

Then call, in order:

```text
subagent_capability({ mode: "wait" })
subagent_wait({ all: true, timeoutMs: 120000 })
subagent_capability({ mode: "minimal" })
```

## 5. Collect

Run immediately; do not diagnose first:

```bash
node benchmarks/scripts/collect-session.mjs <runId>
```

## 6. Finalize

Run:

```bash
node benchmarks/scripts/finalize-run.mjs <runId>
```

Report only the finalizer output: run/status, scenarios, context bytes, schema ratio, capability sequence, extra calls, informational token/time metrics, dirty-runtime status, and result/report paths.
