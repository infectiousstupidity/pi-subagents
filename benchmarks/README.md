# pi-subagents benchmark

Run `/bench-subagent` from a fresh Pi session. The command resolves the installed package path, so the session cwd does not matter.

## What it proves

The benchmark intentionally covers only four regression classes:

- startup context tax,
- compact single + `calls[]` delegation,
- advanced progressive disclosure + exact restoration to minimal,
- async + `subagent_wait` progressive disclosure + exact restoration to minimal.

Budget: **4 parent `subagent` calls / 5 child runs**. There are no reviewer agents, coding puzzles, or diagnostic retries.

PASS/FAIL is deterministic. Parent/child token usage and wall time are informational only. A clean functional run warns only for benchmark-relevant dirty runtime files or >5% growth in the minimal schema / pi-subagents model-facing tool definitions versus a comparable clean PASS.

## Results

Generated data stays outside the checkout:

```text
~/.pi/benchmarks/pi-subagents/
├── RESULTS.md
└── runs/<run-id>/
    ├── meta.json
    ├── static.json
    ├── metrics.json
    └── report.md
```

Pi keeps the raw parent/child sessions in its normal session store.

Only compare benchmark rows with the same benchmark version, Pi version, provider, and model. Increment `benchmarks/benchmark.json` when the workload or measurement semantics change.
