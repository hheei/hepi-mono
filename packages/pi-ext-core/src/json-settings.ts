import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

export interface PiSettingsPaths {
	/** User-wide settings base, normally `<agent-dir>/settings.json`. */
	readonly globalPath: string;
	/** Project-local override, normally `<cwd>/.pi/settings.json`. */
	readonly projectPath: string;
}

export type JsonSettingsValueSource = "global" | "project" | "mixed";

export interface MergedJsonSettingsSection {
	/** Raw layers are exposed so consumers can apply stricter trust rules than project-wins merge. */
	readonly global: Readonly<Record<string, unknown>>;
	readonly project: Readonly<Record<string, unknown>>;
	readonly merged: Readonly<Record<string, unknown>>;
	/** Reports which raw layer contributed the value at a nested path. */
	sourceOf(path: readonly string[]): JsonSettingsValueSource | undefined;
}

export interface ReadMergedJsonSettingsSectionOptions {
	readonly paths: PiSettingsPaths;
	readonly section: string;
	/** Optional caller-owned cancellation for both reads and the final merge boundary. */
	readonly signal?: AbortSignal;
}

interface LocatedSettingValue {
	readonly found: boolean;
	readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

/** Resolves Pi's established global and project settings file locations. */
export function defaultPiSettingsPaths(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): PiSettingsPaths {
	return {
		globalPath: join(agentDir, "settings.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "settings.json"),
	};
}

/** Reads one settings root without applying feature schema or scope policy. Missing files are empty. */
export async function readJsonSettingsRoot(
	path: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, { encoding: "utf8", signal });
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}`, { cause: error });
	}
	if (!isRecord(value)) throw new Error(`Expected JSON object root in ${path}`);
	return value;
}

/** Reads one named object section without interpreting its fields. Missing sections are undefined. */
export async function readJsonSettingsSection(
	path: string,
	section: string,
	signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	const root = await readJsonSettingsRoot(path, signal);
	const value = root[section];
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`Expected ${section} to be an object in ${path}`);
	return value;
}

function childAt(value: unknown, key: string): LocatedSettingValue {
	if (!isRecord(value) || !Object.hasOwn(value, key)) return { found: false };
	return { found: true, value: value[key] };
}

function mergeSettingsObjects(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...global };
	for (const [key, projectValue] of Object.entries(project)) {
		const globalValue = global[key];
		merged[key] =
			isRecord(globalValue) && isRecord(projectValue)
				? mergeSettingsObjects(globalValue, projectValue)
				: projectValue;
	}
	return merged;
}

function sourceAt(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	path: readonly string[],
): JsonSettingsValueSource | undefined {
	let globalValue: unknown = global;
	let projectValue: unknown = project;
	let hasGlobal = true;
	let hasProject = true;
	for (const key of path) {
		if (hasGlobal && hasProject) {
			if (!isRecord(globalValue) || !isRecord(projectValue)) return undefined;
			const nextGlobal = childAt(globalValue, key);
			const nextProject = childAt(projectValue, key);
			hasGlobal = nextGlobal.found;
			hasProject = nextProject.found;
			globalValue = nextGlobal.value;
			projectValue = nextProject.value;
			continue;
		}
		if (hasGlobal) {
			const nextGlobal = childAt(globalValue, key);
			hasGlobal = nextGlobal.found;
			globalValue = nextGlobal.value;
			continue;
		}
		const nextProject = childAt(projectValue, key);
		hasProject = nextProject.found;
		projectValue = nextProject.value;
	}
	if (!hasGlobal && !hasProject) return undefined;
	if (!hasGlobal) return "project";
	if (!hasProject) return "global";
	return isRecord(globalValue) && isRecord(projectValue) ? "mixed" : "project";
}

/**
 * Loads both layers and a default project-wins recursive merge. Consumers that
 * restrict project trust must use `global` and `project`, not `merged`; core does
 * not decide whether project values are safe for a feature's policy.
 */
export async function readMergedJsonSettingsSection(
	options: ReadMergedJsonSettingsSectionOptions,
): Promise<MergedJsonSettingsSection> {
	const [global = {}, project = {}] = await Promise.all([
		readJsonSettingsSection(options.paths.globalPath, options.section, options.signal),
		readJsonSettingsSection(options.paths.projectPath, options.section, options.signal),
	]);
	options.signal?.throwIfAborted();
	return {
		global,
		project,
		merged: mergeSettingsObjects(global, project),
		sourceOf: (path): JsonSettingsValueSource | undefined => sourceAt(global, project, path),
	};
}

async function writeJsonSettingsRoot(
	path: string,
	root: Readonly<Record<string, unknown>>,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			signal,
		});
		signal?.throwIfAborted();
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

declare global {
	var __hepiJsonSettingsWriteQueues: Map<string, Promise<void>> | undefined;
}

function settingsWriteQueues(): Map<string, Promise<void>> {
	globalThis.__hepiJsonSettingsWriteQueues ??= new Map();
	return globalThis.__hepiJsonSettingsWriteQueues;
}

/**
 * Serializes in-process writers and locks across processes before atomically
 * replacing a settings root. Consumers own section/schema merge semantics; the
 * updater must mutate the supplied root synchronously before this function writes it.
 */
export async function updateJsonSettingsRoot(
	path: string,
	update: (root: Record<string, unknown>) => void,
	signal?: AbortSignal,
): Promise<void> {
	const queues = settingsWriteQueues();
	const previous = queues.get(path) ?? Promise.resolve();
	const current = previous
		.catch(() => undefined)
		.then(async () => {
			signal?.throwIfAborted();
			await mkdir(dirname(path), { recursive: true });
			signal?.throwIfAborted();
			const release = await lock(path, {
				realpath: false,
				retries: { retries: 100, minTimeout: 20, maxTimeout: 20 },
			});
			try {
				// Read-modify-write occurs under the process lock and the per-path queue,
				// preventing sibling settings providers from losing each other's sections.
				signal?.throwIfAborted();
				const root = await readJsonSettingsRoot(path, signal);
				update(root);
				await writeJsonSettingsRoot(path, root, signal);
			} finally {
				await release();
			}
		});
	queues.set(path, current);
	try {
		await current;
	} finally {
		if (queues.get(path) === current) queues.delete(path);
	}
}
