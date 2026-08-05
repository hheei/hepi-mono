import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import {
	buildGrepDetails,
	grepNeedsBuiltinFallback,
	inferFffGrepMode,
} from "./fff/extension-common.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { addGrepSummary, normalizeNativeGrepResult } from "./grep-format.js";
import { renderGrepCall, renderGrepResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
const execFileAsync = promisify(execFile);

async function isGitIgnoredPath(targetPath: string | undefined, cwd: string): Promise<boolean> {
	if (targetPath === undefined) return false;
	try {
		await execFileAsync("git", ["check-ignore", "--no-index", "-q", "--", targetPath], { cwd });
		return true;
	} catch {
		return false;
	}
}

export function registerGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const template = createGrepToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		renderCall: (args, theme, context) => renderGrepCall(args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderGrepResult(result, options, theme, context),
		async execute(id, params, signal, onUpdate, context) {
			const original = createGrepToolDefinition(context.cwd);
			const native = async () =>
				normalizeNativeGrepResult(await original.execute(id, params, signal, onUpdate, context));
			const artifacts = state.getArtifacts();
			if (
				params.path !== undefined &&
				artifacts !== undefined &&
				params.path.startsWith("artifact://")
			) {
				const text = artifacts.read(params.path);
				const pattern = params.literal
					? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					: params.pattern;
				const expression = new RegExp(pattern, params.ignoreCase ? "i" : "");
				const lines = text
					.split("\\n")
					.flatMap((line: string, index: number) =>
						expression.test(line) ? [`${index + 1}:${line}`] : [],
					);
				return {
					content: [{ type: "text" as const, text: lines.join("\\n") }],
					details: undefined,
				};
			}
			const runtime = state.getRuntime();
			const ignoredPath = await isGitIgnoredPath(params.path, context.cwd);
			if (
				!runtime ||
				!state.getSettings().grepEnhancement ||
				ignoredPath ||
				grepNeedsBuiltinFallback({
					pattern: params.pattern,
					...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
				})
			)
				return native();
			try {
				const result = await runtime.grepSearch({
					pattern: params.pattern,
					mode: inferFffGrepMode(params.literal),
					...(params.path === undefined ? {} : { pathQuery: params.path }),
					...(params.glob === undefined ? {} : { glob: params.glob }),
					...(params.context === undefined ? {} : { context: params.context }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				});
				if (result.isErr()) return native();
				const files = new Set(result.value.items.map((item) => item.relativePath));
				return {
					content: [
						{
							type: "text" as const,
							text: addGrepSummary(result.value.formatted, {
								matches: result.value.items.length,
								files: files.size,
							}),
						},
					],
					details: buildGrepDetails(result.value),
				};
			} catch {
				return native();
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "grep",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
