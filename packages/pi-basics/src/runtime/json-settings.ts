import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import type { HePiSettingsState, HePiSettingsStorage, HePiSettingValue } from "../api/settings.js";

export interface JsonSectionSettingsStorageOptions {
	readonly path?: string;
	readonly section: string;
	readonly group: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is HePiSettingValue {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function readRoot(path: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error(`Expected JSON object root in ${path}`);
	return value;
}

async function writeRoot(path: string, root: Readonly<Record<string, unknown>>): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
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

export async function updateJsonSettingsRoot(
	path: string,
	update: (root: Record<string, unknown>) => void,
): Promise<void> {
	const writeQueues = settingsWriteQueues();
	const previous = writeQueues.get(path) ?? Promise.resolve();
	const current = previous
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			const release = await lock(path, {
				realpath: false,
				retries: { retries: 100, minTimeout: 20, maxTimeout: 20 },
			});
			try {
				const root = await readRoot(path);
				update(root);
				await writeRoot(path, root);
			} finally {
				await release();
			}
		});
	writeQueues.set(path, current);
	try {
		await current;
	} finally {
		if (writeQueues.get(path) === current) writeQueues.delete(path);
	}
}

export function createJsonSectionSettingsStorage(
	options: JsonSectionSettingsStorageOptions,
): HePiSettingsStorage {
	const resolvePath = (): string => options.path ?? join(getAgentDir(), "settings.json");
	return {
		async load(): Promise<HePiSettingsState | undefined> {
			const root = await readRoot(resolvePath());
			const section = root[options.section];
			if (section !== undefined && !isRecord(section))
				throw new Error(`Expected ${options.section} to be an object in ${resolvePath()}`);
			const group = section?.[options.group];
			if (!isRecord(group)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(group).filter((entry): entry is [string, HePiSettingValue] =>
						isSettingValue(entry[1]),
					),
				),
			};
		},
		async save(state): Promise<void> {
			const path = resolvePath();
			await updateJsonSettingsRoot(path, (root) => {
				const currentSection = root[options.section];
				if (currentSection !== undefined && !isRecord(currentSection))
					throw new Error(`Expected ${options.section} to be an object in ${path}`);
				root[options.section] = {
					...(currentSection ?? {}),
					[options.group]: { ...(state[options.group] ?? {}) },
				};
			});
		},
	};
}
