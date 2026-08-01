import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_CHILD_TOOLS: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];
const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const HISTORICAL_EXPLORE_MODEL = { provider: "anthropic", id: "claude-haiku-4-5" } as const;

export type ProfileModelSelection = "default" | "explicit" | "historical-fallback";

/** Immutable execution policy after built-in or project-file resolution. */
export interface ResolvedProfile {
	readonly name: string;
	readonly systemPrompt: string;
	readonly tools: readonly string[];
	readonly thinking?: ThinkingLevel;
	readonly model?: Model<Api>;
	readonly modelSelection: ProfileModelSelection;
}

export interface ResolveProfileOptions {
	readonly cwd: string;
	readonly name: string;
	readonly modelRegistry: Pick<
		ModelRegistry,
		"find" | "hasConfiguredAuth" | "getRegisteredProviderIds"
	>;
	readonly signal?: AbortSignal;
	readonly readProjectFile?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
}

interface RawProjectProfile {
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly tools?: readonly string[];
	readonly systemPrompt: string;
}

function isModelReference(value: string): boolean {
	const segments = value.split("/");
	return (
		segments.length === 2 &&
		segments[0]?.trim() === segments[0] &&
		segments[1]?.trim() === segments[1] &&
		segments.every(Boolean)
	);
}

function isAgentName(value: string): boolean {
	return (
		Boolean(value.trim()) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		value !== "." &&
		value !== ".."
	);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProjectProfile(name: string, content: string): RawProjectProfile {
	if (content.startsWith("---") && content.indexOf("\n---", 3) === -1) {
		throw new Error(`Profile ${name} has an unterminated frontmatter block`);
	}
	let parsed: { readonly frontmatter: unknown; readonly body: string };
	try {
		parsed = parseFrontmatter(content);
	} catch {
		throw new Error(`Profile ${name} has malformed frontmatter`);
	}
	if (!isRecord(parsed.frontmatter))
		throw new Error(`Profile ${name} frontmatter must be an object`);
	for (const key of Object.keys(parsed.frontmatter)) {
		if (key !== "model" && key !== "thinking" && key !== "tools")
			throw new Error(`Profile ${name} has unknown frontmatter field ${key}`);
	}
	const { model, thinking, tools } = parsed.frontmatter;
	if (model !== undefined && (typeof model !== "string" || !isModelReference(model)))
		throw new Error(`Profile ${name} model must be exact provider/model`);
	if (thinking !== undefined && !isThinkingLevel(thinking))
		throw new Error(`Profile ${name} thinking is invalid`);
	if (
		tools !== undefined &&
		(!Array.isArray(tools) ||
			!tools.every(
				(tool): tool is string => typeof tool === "string" && SUPPORTED_CHILD_TOOLS.includes(tool),
			))
	)
		throw new Error(`Profile ${name} tools must contain supported built-in tool names`);
	return {
		systemPrompt: parsed.body.trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(tools === undefined ? {} : { tools: [...tools] }),
	};
}

async function readProjectProfile(
	path: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		return await readFile(path, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function resolveExplicitModel(
	name: string,
	modelReference: string,
	modelRegistry: ResolveProfileOptions["modelRegistry"],
): Model<Api> {
	const [provider, modelId] = modelReference.split("/");
	if (provider === undefined || modelId === undefined)
		throw new Error(`Profile ${name} model is invalid`);
	const model = modelRegistry.find(provider, modelId);
	if (model === undefined || !modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Profile ${name} selects unavailable model ${modelReference}`);
	return model;
}

function builtInProfile(
	name: string,
	modelRegistry: ResolveProfileOptions["modelRegistry"],
): ResolvedProfile | undefined {
	switch (name) {
		case "general-purpose":
			return {
				name,
				systemPrompt: "",
				tools: ["read", "bash", "edit", "write"],
				modelSelection: "default",
			};
		case "Explore": {
			const model = modelRegistry.find(
				HISTORICAL_EXPLORE_MODEL.provider,
				HISTORICAL_EXPLORE_MODEL.id,
			);
			const dynamic = modelRegistry
				.getRegisteredProviderIds()
				.includes(HISTORICAL_EXPLORE_MODEL.provider);
			return {
				name,
				systemPrompt: "Explore the codebase and report relevant evidence. Do not modify files.",
				tools: [...READ_ONLY_TOOLS],
				...(model !== undefined && !dynamic && modelRegistry.hasConfiguredAuth(model)
					? { model }
					: {}),
				modelSelection:
					model !== undefined && !dynamic && modelRegistry.hasConfiguredAuth(model)
						? "explicit"
						: "historical-fallback",
			};
		}
		case "Plan":
			return {
				name,
				systemPrompt:
					"Explore the codebase and return an implementation plan. Do not modify files.",
				tools: [...READ_ONLY_TOOLS],
				modelSelection: "default",
			};
		default:
			return undefined;
	}
}

/** Resolves only one exact project override; no global or directory discovery occurs. */
export async function resolveProfile(options: ResolveProfileOptions): Promise<ResolvedProfile> {
	if (!isAgentName(options.name)) throw new Error("Agent profile name is invalid");
	options.signal?.throwIfAborted();
	const path = join(options.cwd, ".pi", "agents", `${options.name}.md`);
	const content = await (options.readProjectFile ?? readProjectProfile)(path, options.signal);
	options.signal?.throwIfAborted();
	if (content !== undefined) {
		const project = parseProjectProfile(options.name, content);
		const model =
			project.model === undefined
				? undefined
				: resolveExplicitModel(options.name, project.model, options.modelRegistry);
		return {
			name: options.name,
			systemPrompt: project.systemPrompt,
			tools: project.tools ?? ["read", "bash", "edit", "write"],
			...(project.thinking === undefined ? {} : { thinking: project.thinking }),
			...(model === undefined ? {} : { model }),
			modelSelection: model === undefined ? "default" : "explicit",
		};
	}
	const builtIn = builtInProfile(options.name, options.modelRegistry);
	if (builtIn === undefined) throw new Error(`Unknown agent profile ${options.name}`);
	return builtIn;
}
