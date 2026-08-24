# pi-subagents benchmark

Run it from a **fresh Pi session** in the `pi-subagents` repo:

```text
/bench-subagent
```

That command is a prompt template, not another always-loaded benchmark skill. This is intentional: benchmark instructions are read only when invoked, so the benchmark itself does not add a permanent model-context tax.

## What it measures

- fixed/default context proxy: first parent turn usage before any subagent is loaded,
- exact compact vs full tool-schema size,
- compact single-child execution,
- compact `calls[]` parallel execution,
- worker edit correctness with deterministic tests,
- advanced `workflowScript` progressive disclosure,
- async + `subagent_wait` progressive disclosure,
- restoring the compact surface,
- parent/nested token and cache usage,
- wall time and unnecessary capability/retry behavior,
- two independent post-run reviews of the saved Pi session.

Hard pass/fail comes from deterministic checks. Reviewer subagents add diagnosis; they do not invent the benchmark score.

## Results

Generated data is intentionally outside the git checkout:

```text
~/.pi/benchmarks/pi-subagents/
├── RESULTS.md
└── runs/<run-id>/
    ├── meta.json
    ├── static.json
    ├── metrics.json
    ├── review-efficiency.md
    ├── review-correctness.md
    ├── report.md
    └── workspace/
```

Pi sessions remain in Pi's normal session store. The benchmark records the session path but does not copy the raw transcript into the benchmark directory.

## Comparison rule

Static schema metrics and deterministic scenarios are comparable across environments. Token and wall-time deltas should only be treated as meaningful when benchmark version, Pi version, provider, and model are the same.

When the benchmark itself changes materially, increment `benchmarks/benchmark.json` `version` rather than silently comparing unlike runs.
