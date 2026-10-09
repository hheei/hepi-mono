import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { formatGrepError } from "./error-format.js";
import {
	buildGrepDetails,
	FFF_RUNTIME_NOT_READY_TEXT,
	normalizeOutputMode,
} from "./extension-common.js";
import type { FffRuntimeState } from "./lifecycle.js";

const MULTI_GREP_DESCRIPTION =
	"Search file contents for any of multiple literal patterns using fff multi-grep.";

/**
 * ponytail: dormant FFF-only implementation; keep it unregistered until a
 * translated unified grep contract has a product consumer and focused tests.
 */
export function registerMultiGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const tool = {
		name: "fff_multi_grep",
		label: "FFF Multi Grep",
		description: MULTI_GREP_DESCRIPTION,
		parameters: Type.Object({
			patterns: Type.Array(Type.String(), { minItems: 1 }),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
			constraints: Type.Optional(Type.String()),
			context: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			cursor: Type.Optional(Type.String()),
			outputMode: Type.Optional(Type.String()),
		}),
		async execute(
			_id: string,
			params: {
				patterns: string[];
				path?: string;
				glob?: string;
				constraints?: string;
				context?: number;
				limit?: number;
				cursor?: string;
				outputMode?: string;
			},
		) {
			const runtime = state.getRuntime();
			if (!runtime) return textToolResult(FFF_RUNTIME_NOT_READY_TEXT, buildGrepDetails());
			const result = await runtime.multiGrepSearch({
				patterns: params.patterns,
				...(params.path === undefined ? {} : { pathQuery: params.path }),
				...(params.glob === undefined ? {} : { glob: params.glob }),
				...(params.constraints === undefined ? {} : { constraints: params.constraints }),
				...(params.context === undefined ? {} : { context: params.context }),
				limit: params.limit ?? 60,
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				includeCursorHint: false,
				outputMode: normalizeOutputMode(params.outputMode) ?? "files_with_matches",
			});
			if (!result.ok) throw new Error(formatGrepError(result.error, params.path));
			return textToolResult(result.value.formatted, buildGrepDetails(result.value));
		},
	};
	pi.registerTool(tool);
}
