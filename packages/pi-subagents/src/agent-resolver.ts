import type { Dirent } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandHome, isRecord } from "@hheei/pi-ext-core";
import { builtinAgents } from "./builtin-agents.js";
import type {
	ExtensionSelection,
	McpSelection,
	ResolvedAgentPolicy,
	ResolvedModel,
	Selection,
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
	codemode: true,
	mcp: true,
};

/** Detects whether codemode is configured with mode: "only" in settings or environment. */
export function detectCodemodeOnly(cwd?: string, homeDirectory?: string): boolean {
	if (process.env.PI_CODEMODE_MODE === "only") return true;
	try {
		const agentDir =
			process.env.PI_CODING_AGENT_DIR !== undefined && process.env.PI_CODING_AGENT_DIR !== ""
				? process.env.PI_CODING_AGENT_DIR
				: homeDirectory !== undefined
					? join(homeDirectory, ".pi", "agent")
					: getAgentDir();

		// Project settings (.pi/settings.json in cwd) take precedence over user settings (.pi/agent/settings.json)
		if (cwd) {
			const projectSettings = join(cwd, ".pi", "settings.json");
			if (existsSync(projectSettings)) {
				const content: unknown = JSON.parse(readFileSync(projectSettings, "utf8"));
				if (
					isRecord(content) &&
					isRecord(content.codemode) &&
					typeof content.codemode.mode === "string"
				) {
					return content.codemode.mode === "only";
				}
			}
		}

		const userSettings = join(agentDir, "settings.json");
		if (existsSync(userSettings)) {
			const content: unknown = JSON.parse(readFileSync(userSettings, "utf8"));
			if (
				isRecord(content) &&
				isRecord(content.codemode) &&
				typeof content.codemode.mode === "string"
			) {
				return content.codemode.mode === "only";
			}
		}
	} catch {
		// Ignore filesystem or JSON parse failures
	}
	return false;
}

export function isCodemodeOnlyMode(options: {
	cwd?: string;
	homeDirectory?: string;
	frontmatterCodemode?: unknown;
}): boolean {
	const val = options.frontmatterCodemode;
	if (val === "only" || val === true) return true;
	if (val === "on" || val === false || val === "off") return false;
	return detectCodemodeOnly(options.cwd, options.homeDirectory);
}

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

/**
 * One skill Pi has loaded, as the parent sees it. A definition names skills the way Pi lists them,
 * so the parent's own catalog is the only authority for name → path; nothing here re-scans disk.
 */
export interface SkillCatalogEntry {
	readonly name: string;
	readonly path: string;
}

export interface ResolveAgentOptions {
	readonly name: string;
	readonly cwd: string;
	readonly modelRegistry: ModelRegistryLike;
	readonly parent: ParentAgentDefaults;
	/** Absolute path to this package's extension entry, always kept in the child extension selection. */
	readonly bridgeExtensionPath: string;
	readonly homeDirectory?: string;
	/** Parent's loaded skills, the catalog a definition's skill names resolve against. */
	readonly skillCatalog?: readonly SkillCatalogEntry[];
	/** Diagnostics for the caller to surface; a caller that omits this drops them. */
	readonly onWarning?: (message: string) => void;
}

export interface DiscoveredAgent {
	readonly name: string;
	readonly path: string;
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
	readonly enabled?: boolean;
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

const DEFAULT_PI_TOOLS = ["read", "bash", "edit", "write"] as const;

export type PiSelectionType = "all" | "none" | "whitelist" | "modifier";

export interface ParsedPiSelection {
	readonly type: PiSelectionType;
	readonly names?: readonly string[];
	readonly modifiers?: readonly string[];
	readonly add?: readonly string[];
	readonly remove?: readonly string[];
}

function isModifier(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

export function parsePiSelection(value: unknown, field: string, path: string): ParsedPiSelection {
	if (value === undefined || value === true || value === "all") {
		return { type: "all" };
	}
	if (value === false || value === "none") {
		return { type: "none" };
	}
	const raw = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(raw)) {
		throw readableError(path, `${field} must be a boolean, string, or string array`);
	}
	const entries = raw.map((item) => requiredString(item, field, path));
	if (entries.length === 0) {
		return { type: "none" };
	}
	const modifiers = entries.filter(isModifier);
	if (modifiers.length > 0) {
		if (modifiers.length < entries.length) {
			throw readableError(path, `cannot mix exact names with +name or -name entries in ${field}`);
		}
		const add: string[] = [];
		const remove: string[] = [];
		for (const entry of modifiers) {
			if (entry.includes("*")) {
				throw readableError(
					path,
					`+name and -name entries take exact names, not patterns: ${entry}`,
				);
			}
			const name = entry.slice(1).trim();
			if (name === "") {
				throw readableError(path, `${field} entry has empty modifier name`);
			}
			if (entry.startsWith("+")) {
				if (!add.includes(name)) add.push(name);
			} else {
				if (!remove.includes(name)) remove.push(name);
			}
		}
		return {
			type: "modifier",
			modifiers: Object.freeze(entries),
			add: Object.freeze(add),
			remove: Object.freeze(remove),
		};
	}
	if (new Set(entries).size !== entries.length) {
		throw readableError(path, `${field} selects the same entry twice`);
	}
	return { type: "whitelist", names: Object.freeze(entries) };
}

function applyModifiers(base: readonly string[], modifiers: readonly string[]): string[] {
	const result = [...base];
	for (const entry of modifiers) {
		const name = entry.slice(1).trim();
		if (entry.startsWith("+")) {
			if (!result.includes(name)) result.push(name);
		} else if (entry.startsWith("-")) {
			const idx = result.indexOf(name);
			if (idx !== -1) result.splice(idx, 1);
		}
	}
	return result;
}

function mergeDiscoveredFrontmatter(
	builtinFm: Record<string, unknown>,
	userFm: Record<string, unknown>,
	path: string,
	inheritBaseDefaults: boolean,
): Record<string, unknown> {
	const merged: Record<string, unknown> = inheritBaseDefaults
		? { ...builtinFm, ...userFm }
		: { ...userFm };

	if (userFm.tools !== undefined) {
		const parsedUser = parsePiSelection(userFm.tools, "tools", path);
		if (parsedUser.type === "modifier") {
			const baseTools = stringList(builtinFm.tools, "tools", path);
			const evaluatedTools = applyModifiers(baseTools, parsedUser.modifiers ?? []);
			merged.tools = evaluatedTools;
			const existing = Array.isArray(merged.exclude_tools)
				? (merged.exclude_tools as string[])
				: typeof merged.exclude_tools === "string"
					? [merged.exclude_tools]
					: [];
			const currentExcludes = existing.filter((e) => !evaluatedTools.includes(e));
			const finalRemovals = (parsedUser.remove ?? []).filter((r) => !evaluatedTools.includes(r));
			merged.exclude_tools = Array.from(new Set([...currentExcludes, ...finalRemovals]));
		}
	}

	if (userFm.skills !== undefined) {
		const parsedUser = parsePiSelection(userFm.skills, "skills", path);
		if (parsedUser.type === "modifier") {
			if (Array.isArray(builtinFm.skills)) {
				const baseSkills = stringList(builtinFm.skills, "skills", path);
				merged.skills = applyModifiers(baseSkills, parsedUser.modifiers ?? []);
			} else {
				merged.skills = userFm.skills;
			}
		}
	}

	if (userFm.mcp !== undefined) {
		const parsedUser = parsePiSelection(userFm.mcp, "mcp", path);
		if (parsedUser.type === "modifier") {
			if (Array.isArray(builtinFm.mcp)) {
				const baseMcp = stringList(builtinFm.mcp, "mcp", path);
				merged.mcp = applyModifiers(baseMcp, parsedUser.modifiers ?? []);
			} else if (builtinFm.mcp === false) {
				const evaluated = applyModifiers([], parsedUser.modifiers ?? []);
				merged.mcp = evaluated.length > 0 ? evaluated : false;
			} else {
				merged.mcp = userFm.mcp;
			}
		}
	}

	return merged;
}

function mcpSelection(value: unknown, path: string): McpSelection {
	const parsed = parsePiSelection(value, "mcp", path);
	if (parsed.type === "none") {
		return Object.freeze({ enabled: false });
	}
	if (parsed.type === "all") {
		return Object.freeze({ enabled: true });
	}
	if (parsed.type === "whitelist") {
		const servers = parsed.names;
		return Object.freeze({
			enabled: true,
			...(servers !== undefined ? { servers } : {}),
		});
	}
	const excluded: string[] = [];
	for (const entry of parsed.modifiers ?? []) {
		const name = entry.slice(1).trim();
		if (entry.startsWith("-")) {
			if (!excluded.includes(name)) excluded.push(name);
		} else if (entry.startsWith("+")) {
			const idx = excluded.indexOf(name);
			if (idx !== -1) excluded.splice(idx, 1);
		}
	}
	const result: McpSelection = {
		enabled: true,
		...(excluded.length > 0 ? { excluded } : {}),
	};
	return Object.freeze(result);
}

async function resourceSelection(
	value: unknown,
	field: "extensions",
	path: string,
	homeDirectory: string,
): Promise<Selection> {
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

/**
 * Skills are chosen as a whitelist, unlike extensions: a list means "exactly these", because
 * inheriting every discovered skill is the thing a definition usually wants to narrow. A bare
 * word is a skill *name* and resolves against the parent's loaded catalog, which also gives the
 * absolute path the child needs; anything path-shaped stays what it was, and a name the catalog
 * does not know is dropped with a warning rather than silently matching nothing.
 */
async function skillSelection(
	value: unknown,
	path: string,
	homeDirectory: string,
	catalog: readonly SkillCatalogEntry[] | undefined,
): Promise<Selection> {
	const parsed = parsePiSelection(value, "skills", path);
	if (parsed.type === "all") {
		return { discovery: true, paths: [] };
	}
	if (parsed.type === "none") {
		return { discovery: false, paths: [] };
	}
	if (parsed.type === "whitelist") {
		const paths: string[] = [];
		for (const entry of parsed.names ?? []) {
			if (LOCAL_PATH_PATTERN.test(entry)) {
				const selected = resolve(dirname(path), expandHome(entry, homeDirectory));
				const exists = await stat(selected).then(
					() => true,
					() => false,
				);
				if (!exists) throw readableError(path, `skills entry does not exist: ${selected}`);
				paths.push(selected);
				continue;
			}
			if (entry.includes(":") || entry.includes("/") || entry.includes("\\")) {
				paths.push(entry);
				continue;
			}
			const match = catalog?.find((skill) => skill.name === entry);
			if (match === undefined) {
				// Pass uncatalogued skill name down to Pi CLI so Pi validates it and reports in the subagent panel
				paths.push(entry);
				continue;
			}
			paths.push(match.path);
		}
		return { discovery: false, paths };
	}
	if (catalog === undefined || catalog.length === 0) {
		const paths: string[] = [];
		for (const entry of parsed.modifiers ?? []) {
			if (entry.startsWith("+")) {
				paths.push(entry.slice(1).trim());
			}
		}
		return { discovery: false, paths };
	}
	const baseSkillNames = catalog.map((skill) => skill.name);
	const activeSkillNames = applyModifiers(baseSkillNames, parsed.modifiers ?? []);
	const paths: string[] = [];
	for (const name of activeSkillNames) {
		const match = catalog.find((skill) => skill.name === name);
		if (match !== undefined) {
			paths.push(match.path);
		} else {
			paths.push(name);
		}
	}
	return { discovery: false, paths };
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
	const userAgentDir =
		homeDirectory === homedir()
			? join(getAgentDir(), "agents")
			: process.env.PI_CODING_AGENT_DIR
				? join(process.env.PI_CODING_AGENT_DIR, "agents")
				: join(homeDirectory, ".pi", "agent", "agents");
	return [join(cwd, ".pi", "agents"), join(cwd, ".agents", "agents"), userAgentDir];
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
	const builtins = new Map(builtinAgents().map((a) => [a.name, a]));

	for (const directory of agentDirectories(resolve(cwd), resolve(homeDirectory))) {
		for (const path of await markdownFiles(directory)) {
			const raw = await readAgentDefinition(path);
			if (selected.has(raw.name)) continue;
			const builtin = builtins.get(raw.name);

			const isBuiltin = builtin !== undefined;
			const isBodyEmpty = raw.body.trim() === "";

			let frontmatter: Record<string, unknown>;
			let body: string;

			if (isBuiltin && isBodyEmpty) {
				frontmatter = mergeDiscoveredFrontmatter(builtin.frontmatter, raw.frontmatter, path, true);
				body = builtin.body;
			} else if (isBuiltin && !isBodyEmpty) {
				frontmatter = mergeDiscoveredFrontmatter(builtin.frontmatter, raw.frontmatter, path, false);
				body = raw.body;
			} else {
				frontmatter = raw.frontmatter;
				body = raw.body;
			}

			const isCompliant =
				typeof frontmatter.model === "string" &&
				frontmatter.model.trim() !== "" &&
				(frontmatter.model.trim() === "inherit" || frontmatter.model.includes("/"));

			const agent: DiscoveredAgent = {
				name: raw.name,
				path: raw.path,
				frontmatter,
				body,
				enabled: isCompliant,
			};

			if (!selected.has(agent.name)) selected.set(agent.name, agent);
		}
	}

	// Built-ins not overridden on disk:
	// If a built-in agent explicitly specifies model (e.g. model: inherit like reviewer/worker),
	// it is compliant and directly available.
	// If a built-in agent omits model (like scout), it is non-compliant and not loaded
	// until the user supplements model metadata in user configuration.
	for (const builtin of builtinAgents()) {
		if (!selected.has(builtin.name)) {
			const isCompliant =
				typeof builtin.frontmatter.model === "string" &&
				builtin.frontmatter.model.trim() !== "" &&
				(builtin.frontmatter.model.trim() === "inherit" || builtin.frontmatter.model.includes("/"));
			selected.set(builtin.name, {
				...builtin,
				enabled: isCompliant,
			});
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
	if (value === undefined || value === "inherit") {
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

	const codemodeValue = discovered.frontmatter.codemode;
	if (
		codemodeValue !== undefined &&
		codemodeValue !== "only" &&
		codemodeValue !== "on" &&
		codemodeValue !== "off" &&
		typeof codemodeValue !== "boolean"
	) {
		throw readableError(path, "codemode must be boolean, 'only', 'on', or 'off'");
	}
	const codemodeOnly = isCodemodeOnlyMode({
		cwd: options.cwd,
		homeDirectory,
		frontmatterCodemode: codemodeValue,
	});

	const excludeToolsRaw = stringList(discovered.frontmatter.exclude_tools, "exclude_tools", path);
	if (excludeToolsRaw.includes(CONTACT_PARENT_TOOL_NAME)) {
		throw readableError(
			path,
			`exclude_tools cannot disable the required ${CONTACT_PARENT_TOOL_NAME} bridge`,
		);
	}

	const parsedTools = parsePiSelection(discovered.frontmatter.tools, "tools", path);
	let rawTools: string[];
	const excludeTools: string[] = [...excludeToolsRaw];

	if (parsedTools.type === "none") {
		rawTools = [CONTACT_PARENT_TOOL_NAME];
	} else if (parsedTools.type === "whitelist") {
		rawTools = [...(parsedTools.names ?? [])];
	} else if (parsedTools.type === "modifier") {
		const baseTools = [...DEFAULT_PI_TOOLS, CONTACT_PARENT_TOOL_NAME];
		if (parsedTools.remove?.includes(CONTACT_PARENT_TOOL_NAME)) {
			throw readableError(
				path,
				`tools modifier cannot remove the required ${CONTACT_PARENT_TOOL_NAME} bridge`,
			);
		}
		rawTools = applyModifiers(baseTools, parsedTools.modifiers ?? []);
		const finalExclusions = (parsedTools.remove ?? []).filter((r) => !rawTools.includes(r));
		for (const r of finalExclusions) {
			if (!excludeTools.includes(r)) excludeTools.push(r);
		}
	} else {
		rawTools = [];
	}

	const overlap = rawTools.find((tool) => excludeTools.includes(tool));
	if (overlap !== undefined)
		throw readableError(path, `tool ${overlap} is both allowed and excluded`);

	if (rawTools.length > 0 && !rawTools.includes(CONTACT_PARENT_TOOL_NAME)) {
		throw readableError(path, `tools must include the required ${CONTACT_PARENT_TOOL_NAME} bridge`);
	}

	if (excludeTools.length > 0) {
		rawTools = rawTools.filter((t) => !excludeTools.includes(t));
	}

	const tools =
		rawTools.length > 0 &&
		codemodeOnly &&
		!rawTools.includes("codemode") &&
		!excludeTools.includes("codemode")
			? [...rawTools, "codemode"]
			: rawTools;

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
	const skills = await skillSelection(
		discovered.frontmatter.skills,
		path,
		homeDirectory,
		options.skillCatalog,
	);
	const mcp = mcpSelection(discovered.frontmatter.mcp, path);
	const displayName = optionalString(discovered.frontmatter.display_name, "display_name", path);
	const description = optionalString(discovered.frontmatter.description, "description", path);
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
		codemodeOnly,
		excludeTools: Object.freeze(excludeTools),
		extensions: Object.freeze<ExtensionSelection>({
			discovery: extensionSelection.discovery,
			paths: Object.freeze(extensionPaths),
		}),
		skills: Object.freeze<SkillSelection>({
			discovery: skills.discovery,
			paths: Object.freeze([...skills.paths]),
		}),
		mcp,
		enabled: discovered.enabled !== false,
	});
}
