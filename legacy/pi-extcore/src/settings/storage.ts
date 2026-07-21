import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SettingsStorageAdapter } from "./register.js";
import type { SettingsState } from "./types.js";

interface SettingsFile {
	state: SettingsState;
}

interface SharedSettingsFile {
	providers?: Record<string, SettingsFile | SettingsState | undefined>;
}

const DEFAULT_EXTENSION_SETTINGS_FILE = "ext-settings.json";
const sharedSettingsWriteQueues = new Map<string, Promise<void>>();

export function createAgentExtensionSettingsStorage(
	providerId: string,
	filename = DEFAULT_EXTENSION_SETTINGS_FILE,
): SettingsStorageAdapter {
	return createExtensionSettingsStorage(join(getAgentDir(), filename), providerId);
}

export function createExtensionSettingsStorage(
	filePath: string,
	providerId: string,
): SettingsStorageAdapter {
	const resolvedPath = resolve(filePath);
	return {
		async load(ctx) {
			const file = await readSharedSettingsFile(resolvedPath, ctx);
			return providerStateFromSharedFile(file, providerId);
		},
		async save(state, ctx) {
			await enqueueSharedSettingsWrite(resolvedPath, async () => {
				const file = await readSharedSettingsFile(resolvedPath, ctx);
				const providers = { ...(file.providers ?? {}) };
				providers[providerId] = { state };
				await writeSharedSettingsFile(resolvedPath, { ...file, providers });
			});
		},
	};
}

export function createAgentJsonSettingsStorage(filename: string): SettingsStorageAdapter {
	return createJsonSettingsStorage(join(getAgentDir(), filename));
}

export function createJsonSettingsStorage(filePath: string): SettingsStorageAdapter {
	return {
		async load() {
			try {
				const content = await readFile(filePath, "utf8");
				const data = JSON.parse(content) as unknown;
				return isSettingsFile(data) ? data.state : asSettingsState(data);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return undefined;
				}
				throw error;
			}
		},
		async save(state) {
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${JSON.stringify({ state }, null, 2)}\n`, "utf8");
		},
	};
}

function isSettingsFile(value: unknown): value is SettingsFile {
	return isRecord(value) && isRecord(value.state);
}

async function readSharedSettingsFile(
	filePath: string,
	ctx?: ExtensionContext,
): Promise<SharedSettingsFile> {
	try {
		const content = await readFile(filePath, "utf8");
		const data = JSON.parse(content) as unknown;
		return isRecord(data) ? (data as SharedSettingsFile) : {};
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		if (error instanceof SyntaxError)
			return await recoverMalformedSharedSettingsFile(filePath, ctx, error);
		throw error;
	}
}

async function writeSharedSettingsFile(filePath: string, file: SharedSettingsFile): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}

async function recoverMalformedSharedSettingsFile(
	filePath: string,
	ctx: ExtensionContext | undefined,
	error: SyntaxError,
): Promise<SharedSettingsFile> {
	const backupPath = `${filePath}.bad-${Date.now()}`;
	await rename(filePath, backupPath);
	ctx?.ui.notify(
		`Recovered malformed extension settings. Backed up ${filePath} to ${backupPath}: ${error.message}`,
		"error",
	);
	return {};
}

async function enqueueSharedSettingsWrite(
	filePath: string,
	write: () => Promise<void>,
): Promise<void> {
	const previous = sharedSettingsWriteQueues.get(filePath) ?? Promise.resolve();
	const queued = previous.catch(() => undefined).then(write);
	sharedSettingsWriteQueues.set(filePath, queued);
	try {
		await queued;
	} finally {
		if (sharedSettingsWriteQueues.get(filePath) === queued) {
			sharedSettingsWriteQueues.delete(filePath);
		}
	}
}

function providerStateFromSharedFile(
	file: SharedSettingsFile,
	providerId: string,
): SettingsState | undefined {
	const entry = file.providers?.[providerId];
	if (!entry) return undefined;
	return isSettingsFile(entry) ? entry.state : asSettingsState(entry);
}

function asSettingsState(value: unknown): SettingsState | undefined {
	return isRecord(value) ? (value as SettingsState) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
