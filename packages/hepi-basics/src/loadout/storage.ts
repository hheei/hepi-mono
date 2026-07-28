import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LoadoutKey, LoadoutScope } from "./model.js";

export interface LoadoutStoragePaths {
	readonly globalPath: string;
	readonly projectPath: string;
}

export interface LoadoutStoredState {
	readonly global: Readonly<Record<LoadoutKey, boolean>>;
	readonly project: Readonly<Record<LoadoutKey, boolean>>;
}

export interface LoadoutStorage {
	load(signal?: AbortSignal): Promise<LoadoutStoredState>;
	update(
		scope: LoadoutScope,
		key: LoadoutKey,
		value: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void>;
}

export function defaultLoadoutStoragePaths(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): LoadoutStoragePaths {
	return {
		globalPath: join(agentDir, "settings.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "settings.json"),
	};
}

export async function initialLoadoutScope(cwd: string): Promise<LoadoutScope> {
	try {
		return (await stat(join(cwd, CONFIG_DIR_NAME))).isDirectory() ? "project" : "global";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "global";
		throw error;
	}
}

const loadoutSection = "pi-basics-loadout";
const queues = new Map<string, Promise<void>>();
type JsonObject = Record<string, unknown>;

async function readRoot(path: string, signal?: AbortSignal): Promise<JsonObject> {
	let text: string;
	try {
		text = await readFile(path, { encoding: "utf8", signal });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}`, { cause: error });
	}
	if (root === null || typeof root !== "object" || Array.isArray(root)) {
		throw new Error(`Expected JSON object root in ${path}`);
	}
	const section = (root as JsonObject)[loadoutSection];
	if (section === undefined) return root as JsonObject;
	if (section === null || typeof section !== "object" || Array.isArray(section)) {
		throw new Error(`Expected ${loadoutSection} to be an object in ${path}`);
	}
	for (const [key, value] of Object.entries(section as JsonObject)) {
		if (typeof value !== "boolean") {
			throw new Error(`Expected ${loadoutSection}.${key} to be boolean in ${path}`);
		}
	}
	return root as JsonObject;
}

function readState(root: JsonObject): Record<LoadoutKey, boolean> {
	const section = root[loadoutSection];
	if (section === undefined) return {};
	return { ...(section as Record<LoadoutKey, boolean>) };
}

async function writeRoot(path: string, root: JsonObject, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, {
			encoding: "utf8",
			signal,
		});
		signal?.throwIfAborted();
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function createLoadoutStorage(
	paths: LoadoutStoragePaths = defaultLoadoutStoragePaths(),
): LoadoutStorage {
	const load = async (signal?: AbortSignal): Promise<LoadoutStoredState> => {
		const [globalRoot, projectRoot] = await Promise.all([
			readRoot(paths.globalPath, signal),
			readRoot(paths.projectPath, signal),
		]);
		signal?.throwIfAborted();
		return { global: readState(globalRoot), project: readState(projectRoot) };
	};
	const update = async (
		scope: LoadoutScope,
		key: LoadoutKey,
		value: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void> => {
		signal?.throwIfAborted();
		const path = scope === "global" ? paths.globalPath : paths.projectPath;
		const previous = queues.get(path) ?? Promise.resolve();
		const operation = async () => {
			signal?.throwIfAborted();
			const root = await readRoot(path, signal);
			const section = root[loadoutSection];
			if (section === undefined && value === undefined) return;
			const nextSection: JsonObject = section === undefined ? {} : { ...(section as JsonObject) };
			if (value === undefined) delete nextSection[key];
			else nextSection[key] = value;
			root[loadoutSection] = nextSection;
			await writeRoot(path, root, signal);
		};
		const next = previous.then(operation, operation);
		queues.set(path, next);
		try {
			await next;
		} finally {
			if (queues.get(path) === next) queues.delete(path);
		}
	};
	return { load, update };
}
