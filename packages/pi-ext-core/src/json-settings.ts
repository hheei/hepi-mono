import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

export interface PiSettingsPaths {
	readonly globalPath: string;
	readonly projectPath: string;
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

/** Reads one settings root without applying feature schema or scope policy. */
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

/** Reads one named object section without interpreting its fields. */
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
 * replacing a settings root. Consumers own section/schema merge semantics.
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
