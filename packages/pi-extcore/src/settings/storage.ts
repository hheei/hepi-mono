import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SettingsStorageAdapter } from "./register.js";
import type { SettingsState } from "./types.js";

interface SettingsFile {
	state: SettingsState;
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

function asSettingsState(value: unknown): SettingsState | undefined {
	return isRecord(value) ? (value as SettingsState) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
