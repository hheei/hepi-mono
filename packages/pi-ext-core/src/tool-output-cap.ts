import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, SPILL_NOTE_PREFIX, truncateWithSpill } from "./tool-output.js";

/**
 * Names a file prefix per tool, so a spilled result says which tool produced it. Tools that cut
 * their own output already do this; the prefix here covers everything else.
 */
const TOOL_PREFIXES: Readonly<Record<string, string>> = {
	read: "read",
	bash: "bash",
	grep: "grep",
	find: "find",
	edit: "edit",
	write: "write",
	apply_patch: "patch",
	python_eval: "py",
	codemode: "code",
};

/** The prefix a spilled result from `toolName` uses; unknown tools share one bucket. */
export function outputPrefixFor(toolName: string): string {
	return TOOL_PREFIXES[toolName] ?? "tool";
}

/**
 * Caps every tool result at the shared budget, keeping the head and the tail and writing the rest
 * to a file.
 *
 * A tool that already truncated its own output carries the spill note, and its result is left
 * alone: it cut to a budget it could justify (a cell that ran eight nested tools earns a wider one),
 * and cutting it again at the single-call width would throw that away. Results with images are left
 * alone too, because their text is a caption rather than the payload.
 */
export async function capToolResult(event: ToolResultEvent): Promise<
	| {
			readonly content: ToolResultEvent["content"];
	  }
	| undefined
> {
	if (event.content.length !== 1) return undefined;
	const [only] = event.content;
	if (only === undefined || only.type !== "text") return undefined;
	if (only.text.includes(SPILL_NOTE_PREFIX)) return undefined;
	const spilled = await truncateWithSpill(only.text, outputPrefixFor(event.toolName), {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: Number.POSITIVE_INFINITY,
	});
	if (!spilled.truncated) return undefined;
	return { content: [{ type: "text", text: spilled.text }] };
}

/**
 * Installs the shared cap once per extension. Every tool result the model reads passes through it,
 * so a tool that forgets its own bound still cannot flood the context.
 */
export function registerToolOutputCap(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("tool_result", async (event) => await capToolResult(event));
}
