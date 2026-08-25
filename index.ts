import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
const registerParentExtension = isSubagentChild
	? undefined
	: (await import("./src/extension/context-surface.ts")).default;
const registerBenchmarkCommand = isSubagentChild
	? undefined
	: (await import("./src/extension/benchmark-command.ts")).registerBenchmarkCommand;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	registerParentExtension?.(pi);
	registerBenchmarkCommand?.(pi);
}
