import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const benchmarkPath = fileURLToPath(new URL("../../benchmarks/BENCHMARK.md", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function portablePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveBenchmarkSpec(source: string): string {
	const root = portablePath(packageRoot);
	const specPath = portablePath(benchmarkPath);
	return source
		.replace(
			"- Run from the root of the `pi-subagents` checkout under test.",
			`- The package root is resolved by /bench-subagent as \`${root}\`. The Pi session may run from any cwd.`,
		)
		.replace(
			"node --experimental-strip-types benchmarks/scripts/start-run.mjs",
			`node --experimental-strip-types "${root}/benchmarks/scripts/start-run.mjs"`,
		)
		.replace(
			"node benchmarks/scripts/collect-session.mjs <runId>",
			`node "${root}/benchmarks/scripts/collect-session.mjs" <runId>`,
		)
		.replace(
			"node benchmarks/scripts/finalize-run.mjs <runId>",
			`node "${root}/benchmarks/scripts/finalize-run.mjs" <runId>`,
		)
		.replace(
			"this `BENCHMARK.md` file.",
			`the benchmark specification embedded in this saved session (source: \`${specPath}\`).`,
		);
}

function hasExistingUserMessage(branch: unknown[]): boolean {
	return branch.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const message = (entry as { message?: { role?: string } }).message;
		return message?.role === "user";
	});
}

export function registerBenchmarkCommand(pi: ExtensionAPI): void {
	pi.registerCommand("bench-subagent", {
		description: "Run the reproducible pi-subagents benchmark",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Wait for the current turn to finish, then run /bench-subagent in a new session.", "warning");
				return;
			}
			if (hasExistingUserMessage(ctx.sessionManager.getBranch() as unknown[])) {
				if (ctx.hasUI) ctx.ui.notify("/bench-subagent requires a fresh Pi session with no earlier user messages.", "warning");
				return;
			}

			let source: string;
			try {
				source = fs.readFileSync(benchmarkPath, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Cannot load pi-subagents benchmark: ${message}`, "error");
				return;
			}

			const resolved = resolveBenchmarkSpec(source);
			pi.sendUserMessage([
				{ type: "text", text: "BENCH_SUBAGENT_V1" },
				{ type: "text", text: `Resolved package root: ${portablePath(packageRoot)}\n\n${resolved}` },
			]);
		},
	});
}
