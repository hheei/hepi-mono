import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandHome, isRecord } from "@hheei/pi-ext-core";
import type {
	ExtensionSelection,
	ResolvedAgentPolicy,
	ResolvedModel,
	SkillSelection,
	ThinkingLevel,
} from "./domain.js";
import { CONTACT_PARENT_TOOL_NAME, isThinkingLevel } from "./domain.js";

/**
 * Agent definition fields this version actually implements. Anything outside this
 * table fails before launch; `DEFERRED_FIELDS` exists only to give those known
 * candidates a clearer message than an outright typo.
 */
const SUPPORTED_FIELDS: Record<string, true> = {
	name: true,
	display_name: true,
	description: true,
	hidden: true,
	model: true,
	thinking: true,
	tools: true,
	exclude_tools: true,
	extensions: true,
	skills: true,
	interactive: true,
};

/** Recognized candidate fields with no execution semantics yet; silently ignoring them is prohibited. */
const DEFERRED_FIELDS: Record<string, true> = {
	exclude_extensions: true,
	preload_skills: true,
	max_turns: true,
	max_tokens: true,
};

export interface ModelRegistryLike {
	/** `ModelRegistry.find` from the Pi extension context: exact provider/id lookup. */
	find(provider: string, modelId: string): unknown | undefined;
}

export interface ParentAgentDefaults {
	/** Parent's current model, inherited only when the definition does not name one. */
	readonly model: { readonly provider: string; readonly id: string };
	/** Parent's current thinking level, inherited only when the definition does not name one. */
	readonly thinking: ThinkingLevel;
}

export interface ResolveAgentOptions {
	readonly name: string;
	readonly cwd: string;
	readonly modelRegistry: ModelRegistryLike;
	readonly parent: ParentAgentDefaults;
	/** Absolute path to this package's extension entry, always kept in the child extension selection. */
	readonly bridgeExtensionPath: string;
	readonly homeDirectory?: string;
}

export interface DiscoveredAgent {
	readonly name: string;
	readonly path: string;
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
}

function readableError(path: string, message: string): Error {
	return new Error(`Invalid agent definition ${path}: ${message}`);
}

function requiredString(value: unknown, field: string, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw readableError(path, `${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field, path);
}

function stringList(value: unknown, field: string, path: string): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(raw)) throw readableError(path, `${field} must be a string or string array`);
	const values = raw.map((item) => requiredString(item, field, path));
	if (new Set(values).size !== values.length) {
		throw readableError(path, `${field} selects the same entry twice`);
	}
	return values;
}

const LOCAL_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[~/]|\.{1,2}[\\/])/;

/** Local selections become absolute paths next to the definition; package specs are left for Pi to resolve. */
function resolveResourcePaths(
	value: unknown,
	field: string,
	path: string,
	homeDirectory: string,
): string[] {
	return stringList(value, field, path).map((item) => {
		if (!LOCAL_PATH_PATTERN.test(item)) return item;
		const trimmed = expandHome(item, homeDirectory);
		return resolve(dirname(path), trimmed);
	});
}

async function resourceSelection(
	value: unknown,
	field: "extensions" | "skills",
	path: string,
	homeDirectory: string,
): Promise<{ discovery: boolean; paths: string[] }> {
	if (value === undefined || value === true) return { discovery: true, paths: [] };
	if (value === false) return { discovery: false, paths: [] };
	const paths = resolveResourcePaths(value, field, path, homeDirectory);
	for (const selected of paths) {
		if (!isAbsolute(selected)) continue;
		const exists = await stat(selected).then(
			() => true,
			() => false,
		);
		if (!exists) throw readableError(path, `${field} entry does not exist: ${selected}`);
	}
	return { discovery: true, paths };
}

async function markdownFiles(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => join(directory, entry.name))
		.sort((left, right) => left.localeCompare(right));
}

/** Most specific scope first; the first definition of a name wins deterministically. */
function agentDirectories(cwd: string, homeDirectory: string): readonly string[] {
	return [
		join(cwd, ".pi", "agents"),
		join(cwd, ".agents", "agents"),
		join(homeDirectory, ".pi", "agent", "agents"),
	];
}

async function readAgentDefinition(path: string): Promise<DiscoveredAgent> {
	const content = await readFile(path, "utf8").catch((error: unknown) => {
		throw new Error(`Unable to read agent definition ${path}`, { cause: error });
	});
	const parsed = parseFrontmatter(content);
	if (!isRecord(parsed.frontmatter)) throw readableError(path, "frontmatter must be an object");
	return {
		name: requiredString(parsed.frontmatter.name, "name", path),
		path,
		frontmatter: parsed.frontmatter,
		body: parsed.body,
	};
}

export async function discoverAgents(
	cwd: string,
	homeDirectory: string = homedir(),
): Promise<readonly DiscoveredAgent[]> {
	const selected = new Map<string, DiscoveredAgent>();
	for (const directory of agentDirectories(resolve(cwd), resolve(homeDirectory))) {
		for (const path of await markdownFiles(directory)) {
			const agent = await readAgentDefinition(path);
			if (!selected.has(agent.name)) selected.set(agent.name, agent);
		}
	}
	return [...selected.values()];
}

function resolveModel(
	value: unknown,
	defaults: ParentAgentDefaults,
	registry: ModelRegistryLike,
	path: string,
): ResolvedModel {
	if (value === undefined) {
		if (registry.find(defaults.model.provider, defaults.model.id) === undefined) {
			throw readableError(
				path,
				`parent model ${defaults.model.provider}/${defaults.model.id} is unavailable`,
			);
		}
		return { ...defaults.model, source: "parent" };
	}
	const reference = requiredString(value, "model", path);
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) {
		throw readableError(path, "model must use the exact provider/model-id form");
	}
	const provider = reference.slice(0, slash);
	const id = reference.slice(slash + 1);
	if (registry.find(provider, id) === undefined) {
		throw readableError(path, `unknown model ${provider}/${id}`);
	}
	return { provider, id, source: "agent" };
}

/**
 * Resolves one agent definition into an immutable, non-secret policy snapshot.
 * Unknown fields, deferred fields, unknown models, invalid thinking levels,
 * conflicting tool policy, and a disabled `contact_parent` bridge all fail here,
 * before any child process exists.
 */
export async function resolveAgent(options: ResolveAgentOptions): Promise<ResolvedAgentPolicy> {
	const homeDirectory = resolve(options.homeDirectory ?? homedir());
	const agents = await discoverAgents(options.cwd, homeDirectory);
	const discovered = agents.find((agent) => agent.name === options.name);
	if (discovered === undefined) {
		const available = agents.map((agent) => agent.name).join(", ");
		const searched = agentDirectories(resolve(options.cwd), homeDirectory).join(", ");
		throw new Error(
			`Unknown agent ${options.name}. Available: [${available || "none"}]. Searched: ${searched}`,
		);
	}
	const path = discovered.path;
	for (const field of Object.keys(discovered.frontmatter)) {
		if (SUPPORTED_FIELDS[field] === true) continue;
		if (DEFERRED_FIELDS[field] === true) {
			throw readableError(path, `${field} is not part of the V1 agent contract`);
		}
		throw readableError(path, `unsupported field ${field}`);
	}
	// `discovered.name` is already the definition's own `name`; the lookup above proved they match.
	const name = discovered.name;
	const hidden = discovered.frontmatter.hidden ?? false;
	if (typeof hidden !== "boolean") throw readableError(path, "hidden must be boolean");
	const body = discovered.body.trim();
	if (body === "") throw readableError(path, "Markdown body must not be empty");

	const tools = stringList(discovered.frontmatter.tools, "tools", path);
	const excludeTools = stringList(discovered.frontmatter.exclude_tools, "exclude_tools", path);
	if (excludeTools.includes(CONTACT_PARENT_TOOL_NAME)) {
		throw readableError(
			path,
			`exclude_tools cannot disable the required ${CONTACT_PARENT_TOOL_NAME} bridge`,
		);
	}
	const overlap = tools.find((tool) => excludeTools.includes(tool));
	if (overlap !== undefined)
		throw readableError(path, `tool ${overlap} is both allowed and excluded`);
	if (tools.length > 0 && !tools.includes(CONTACT_PARENT_TOOL_NAME)) {
		throw readableError(path, `tools must include the required ${CONTACT_PARENT_TOOL_NAME} bridge`);
	}

	const thinkingValue = discovered.frontmatter.thinking;
	if (thinkingValue !== undefined && !isThinkingLevel(thinkingValue)) {
		throw readableError(path, "thinking is invalid");
	}
	const extensionSelection = await resourceSelection(
		discovered.frontmatter.extensions,
		"extensions",
		path,
		homeDirectory,
	);
	const bridgeExtensionPath = resolve(options.bridgeExtensionPath);
	const extensionPaths = [
		...extensionSelection.paths.filter((selected) => selected !== bridgeExtensionPath),
		bridgeExtensionPath,
	];
	const skills = await resourceSelection(
		discovered.frontmatter.skills,
		"skills",
		path,
		homeDirectory,
	);
	const displayName = optionalString(discovered.frontmatter.display_name, "display_name", path);
	const description = optionalString(discovered.frontmatter.description, "description", path);
	const interactiveValue = discovered.frontmatter.interactive;
	if (interactiveValue !== undefined && typeof interactiveValue !== "boolean") {
		throw readableError(path, "interactive must be boolean");
	}
	const interactive = interactiveValue === true;

	return Object.freeze({
		agent: Object.freeze({
			name,
			...(displayName === undefined ? {} : { displayName }),
			...(description === undefined ? {} : { description }),
			hidden,
			sourcePath: path,
			instructions: body,
		}),
		model: Object.freeze(
			resolveModel(discovered.frontmatter.model, options.parent, options.modelRegistry, path),
		),
		thinking: Object.freeze({
			level: thinkingValue ?? options.parent.thinking,
			source: thinkingValue === undefined ? "parent" : "agent",
		}),
		tools: Object.freeze(tools),
		excludeTools: Object.freeze(excludeTools),
		extensions: Object.freeze<ExtensionSelection>({
			discovery: extensionSelection.discovery,
			paths: Object.freeze(extensionPaths),
		}),
		skills: Object.freeze<SkillSelection>({
			discovery: skills.discovery,
			paths: Object.freeze([...skills.paths]),
		}),
		interactive,
	});
}
