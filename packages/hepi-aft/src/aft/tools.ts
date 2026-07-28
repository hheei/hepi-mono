import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	renderOutlineCall,
	renderOutlineResult,
	renderZoomCall,
	renderZoomResult,
} from "./reading-renderers.js";
import type { HepiAftRuntime } from "./runtime.js";

const outlineParameters = Type.Object({
	target: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
		description: "File path, directory path, HTTP(S) URL, or a non-empty array of file paths.",
	}),
	files: Type.Optional(
		Type.Boolean({ description: "Return a flat directory file tree instead of symbol outlines." }),
	),
	includeTests: Type.Optional(
		Type.Boolean({ description: "Include test files in a directory outline." }),
	),
});

const zoomTarget = Type.Object({
	path: Type.String({ description: "File path, absolute or relative to the project." }),
	symbol: Type.String({ description: "Symbol name in that file." }),
});

const zoomParameters = Type.Object({
	path: Type.Optional(
		Type.String({ description: "File path, absolute or relative to the project." }),
	),
	url: Type.Optional(Type.String({ description: "HTTP(S) document URL." })),
	symbols: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
			description: "One symbol/heading, or multiple symbols/headings in the same target.",
		}),
	),
	targets: Type.Optional(
		Type.Union([zoomTarget, Type.Array(zoomTarget, { minItems: 1 })], {
			description: "One cross-file target or a non-empty batch of targets.",
		}),
	),
	contextLines: Type.Optional(
		Type.Integer({ minimum: 1, description: "Lines of context before and after a result." }),
	),
	callgraph: Type.Optional(Type.Boolean({ description: "Include same-file callers and callees." })),
});

type OutlineParameters = Static<typeof outlineParameters>;
type ZoomParameters = Static<typeof zoomParameters>;
type RuntimeGetter = () => HepiAftRuntime | undefined;

function requireRuntime(getRuntime: RuntimeGetter): HepiAftRuntime {
	const runtime = getRuntime();
	if (runtime === undefined)
		throw new Error("AFT is unavailable. Start a new session or reload after fixing AFT setup.");
	return runtime;
}

function nonEmptyString(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

function hasSymbols(symbols: ZoomParameters["symbols"]): boolean {
	return typeof symbols === "string" ? nonEmptyString(symbols) : (symbols?.length ?? 0) > 0;
}

function hasTargets(targets: ZoomParameters["targets"]): boolean {
	if (targets === undefined) return false;
	const entries = Array.isArray(targets) ? targets : [targets];
	return entries.some((target) => target.path.length > 0 || target.symbol.length > 0);
}

function textResult(response: { readonly text: string; readonly [key: string]: unknown }) {
	return { content: [{ type: "text" as const, text: response.text }], details: response };
}

async function outline(
	runtime: HepiAftRuntime,
	ctx: ExtensionContext,
	params: OutlineParameters,
): Promise<ReturnType<typeof textResult>> {
	const target = Array.isArray(params.target) ? params.target : params.target.trim();
	if ((typeof target === "string" && target.length === 0) || target.length === 0)
		throw new Error("'target' must be a non-empty string or array of strings");
	if (Array.isArray(target) && target.some((entry) => entry.trim().length === 0))
		throw new Error("'target' must not contain empty paths");
	const response = await runtime.toolCall(ctx, "outline", {
		target,
		...(params.files === true ? { files: true } : {}),
		...(params.includeTests !== undefined ? { includeTests: params.includeTests } : {}),
	});
	if (response.success === false)
		throw new Error(response.text || response.message || "outline failed");
	return textResult(response);
}

function validateTargets(targets: ZoomParameters["targets"]): Array<Static<typeof zoomTarget>> {
	if (targets === undefined) throw new Error("'targets' must be non-empty");
	const entries = Array.isArray(targets) ? targets : [targets];
	if (entries.length === 0) throw new Error("'targets' must be non-empty");
	const validEntries: Array<Static<typeof zoomTarget>> = [];
	for (const [index, target] of entries.entries()) {
		if (target === undefined || !nonEmptyString(target.path))
			throw new Error(`targets[${index}].path must be a non-empty string`);
		if (!nonEmptyString(target.symbol))
			throw new Error(`targets[${index}].symbol must be a non-empty string`);
		validEntries.push(target);
	}
	return validEntries;
}

async function zoom(
	runtime: HepiAftRuntime,
	ctx: ExtensionContext,
	params: ZoomParameters,
): Promise<ReturnType<typeof textResult>> {
	const hasPath = nonEmptyString(params.path);
	const hasUrl = nonEmptyString(params.url);
	const includesTargets = hasTargets(params.targets);
	const includesSymbols = hasSymbols(params.symbols);
	if (includesTargets) {
		if (hasPath || hasUrl || includesSymbols)
			throw new Error("'targets' is mutually exclusive with 'path', 'url', and 'symbols'");
		const targets = validateTargets(params.targets);
		const response = await runtime.toolCall(ctx, "zoom", {
			targets: targets.map((target) => ({ filePath: target.path, symbol: target.symbol })),
			...(params.contextLines !== undefined ? { contextLines: params.contextLines } : {}),
			...(params.callgraph === true ? { callgraph: true } : {}),
		});
		if (response.success === false)
			throw new Error(response.text || response.message || "zoom failed");
		return textResult(response);
	}
	if (hasPath === hasUrl) throw new Error("Provide exactly one of 'path', 'url', or 'targets'");
	const response = await runtime.toolCall(ctx, "zoom", {
		...(hasPath ? { filePath: params.path } : { url: params.url }),
		...(includesSymbols ? { symbols: params.symbols } : {}),
		...(params.contextLines !== undefined ? { contextLines: params.contextLines } : {}),
		...(params.callgraph === true ? { callgraph: true } : {}),
	});
	if (response.success === false)
		throw new Error(response.text || response.message || "zoom failed");
	return textResult(response);
}

export function registerAftTools(
	pi: ExtensionAPI,
	getRuntime: RuntimeGetter,
	options: { readonly outline: boolean; readonly zoom: boolean },
): void {
	if (options.outline)
		pi.registerTool({
			name: "aft_outline",
			label: "outline",
			description:
				"Structural outline of source code, documentation files, or remote URLs. Use it to map symbols before reading focused sections with aft_zoom.",
			parameters: outlineParameters,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				await outline(requireRuntime(getRuntime), ctx, params),
			renderCall(args, theme, context) {
				return renderOutlineCall(args, theme, context);
			},
			renderResult(result, _options, theme, context) {
				return renderOutlineResult(result, theme, context);
			},
		});
	if (options.zoom)
		pi.registerTool({
			name: "aft_zoom",
			label: "zoom",
			description:
				"Inspect source symbols or documentation sections. Use path plus symbols, URL plus symbols, or cross-file targets.",
			parameters: zoomParameters,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
				await zoom(requireRuntime(getRuntime), ctx, params),
			renderCall(args, theme, context) {
				return renderZoomCall(args, theme, context);
			},
			renderResult(result, _options, theme, context) {
				return renderZoomResult(result, context.args, theme, context);
			},
		});
}
