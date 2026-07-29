export { default } from "./extension.js";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import OpenCC from "opencc-js/t2cn";
import {
	type HepiSettingField,
	type HepiSettingsProvider,
	type HepiSettingsState,
	updateJsonSettingsRoot,
} from "../core/index.js";

export const TRADITIONAL_TO_SIMPLIFIED_GROUP = "traditional-to-simplified";
export const TRADITIONAL_TO_SIMPLIFIED_FIELD = "mode";

interface Fence {
	char: "`" | "~";
	length: number;
}

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

function matchFence(line: string): Fence | undefined {
	let start = 0;
	while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
	const char = line[start];
	if (char !== "`" && char !== "~") return undefined;
	let end = start;
	while (end < line.length && line[end] === char) end++;
	const length = end - start;
	return length >= 3 ? { char, length } : undefined;
}

function convertProseLine(line: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		const openStart = line.indexOf("`", cursor);
		if (openStart === -1)
			return output + toSimplified(line.slice(cursor)).replaceAll("甚么", "什么");
		output += toSimplified(line.slice(cursor, openStart)).replaceAll("甚么", "什么");
		let openEnd = openStart;
		while (openEnd < line.length && line[openEnd] === "`") openEnd++;
		const delimiterLength = openEnd - openStart;
		let searchFrom = openEnd;
		let closeEnd = -1;
		while (searchFrom < line.length) {
			const candidateStart = line.indexOf("`", searchFrom);
			if (candidateStart === -1) break;
			let candidateEnd = candidateStart;
			while (candidateEnd < line.length && line[candidateEnd] === "`") candidateEnd++;
			if (candidateEnd - candidateStart === delimiterLength) {
				closeEnd = candidateEnd;
				break;
			}
			searchFrom = candidateEnd;
		}
		if (closeEnd === -1) return output + line.slice(openStart);
		output += line.slice(openStart, closeEnd);
		cursor = closeEnd;
	}
	return output;
}

export function convertInputText(text: string): string {
	const lines = text.split("\n");
	let activeFence: Fence | undefined;
	let output = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined) continue;
		const hasLineFeed = index < lines.length - 1;
		const lineWithEnding = hasLineFeed ? `${line}\n` : line;
		const fence = matchFence(line);
		if (activeFence) {
			output += lineWithEnding;
			if (fence?.char === activeFence.char && fence.length >= activeFence.length)
				activeFence = undefined;
			continue;
		}
		if (fence) {
			activeFence = fence;
			output += lineWithEnding;
			continue;
		}
		output += convertProseLine(line);
		if (hasLineFeed) output += "\n";
	}
	return output;
}

export interface TraditionalToSimplifiedFeature {
	start(runtime: { pi: ExtensionAPI; ctx: ExtensionContext }): void;
	dispose(sessionId: string): void;
	setEnabled(enabled: boolean): void;
}

type JsonObject = Record<string, unknown>;
type TraditionalToSimplifiedMode = "t2s" | "off";
const SETTINGS_SECTION = "hepi";

function parseStoredMode(values: JsonObject): TraditionalToSimplifiedMode {
	if (Object.keys(values).some((key) => key !== "mode"))
		throw new Error(`Unexpected ${TRADITIONAL_TO_SIMPLIFIED_GROUP} setting`);
	if (values.mode !== "t2s" && values.mode !== "off")
		throw new Error(`Expected ${TRADITIONAL_TO_SIMPLIFIED_GROUP}.mode to be t2s or off`);
	return values.mode;
}

async function loadSettings(path: string): Promise<JsonObject> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function settingsPath(settingsDirectory = getAgentDir()): string {
	return join(settingsDirectory, "settings.json");
}

export function traditionalToSimplifiedEnabled(state: HepiSettingsState): boolean {
	return state[TRADITIONAL_TO_SIMPLIFIED_GROUP]?.[TRADITIONAL_TO_SIMPLIFIED_FIELD] !== "off";
}

export function createTraditionalToSimplifiedSettingsProvider(
	options: { readonly settingsDirectory?: string } = {},
): HepiSettingsProvider {
	const settingsDirectory = options.settingsDirectory ?? getAgentDir();
	return {
		id: "pi-t2s",
		title: "Traditional to simplified",
		origin: "@hheei/hepi-basics",
		groups: [
			{
				id: TRADITIONAL_TO_SIMPLIFIED_GROUP,
				title: "",
				fields: [
					{
						id: TRADITIONAL_TO_SIMPLIFIED_FIELD,
						label: "ZH translate",
						type: "enum",
						defaultValue: "t2s",
						options: [
							{ value: "t2s", label: "t2s" },
							{ value: "off", label: "off" },
						],
						description: "Convert interactive Traditional Chinese input to Simplified Chinese.",
						parse: (draft) => (draft === "off" ? "off" : "t2s"),
					},
				] satisfies readonly HepiSettingField[],
			},
		],
		storage: {
			async load() {
				const root = await loadSettings(settingsPath(settingsDirectory));
				const section = root[SETTINGS_SECTION];
				if (
					section !== undefined &&
					(typeof section !== "object" || section === null || Array.isArray(section))
				)
					throw new Error(`Expected ${SETTINGS_SECTION} settings to be an object`);
				const values =
					section === undefined
						? undefined
						: (section as JsonObject)[TRADITIONAL_TO_SIMPLIFIED_GROUP];
				if (values === undefined) return undefined;
				if (typeof values !== "object" || values === null || Array.isArray(values))
					throw new Error(`Expected ${TRADITIONAL_TO_SIMPLIFIED_GROUP} settings to be an object`);
				return {
					[TRADITIONAL_TO_SIMPLIFIED_GROUP]: { mode: parseStoredMode(values as JsonObject) },
				};
			},
			async save(state: HepiSettingsState) {
				const path = settingsPath(settingsDirectory);
				const mode = parseStoredMode(state[TRADITIONAL_TO_SIMPLIFIED_GROUP] ?? {});
				await updateJsonSettingsRoot(path, (root) => {
					const section = root[SETTINGS_SECTION];
					if (
						section !== undefined &&
						(typeof section !== "object" || section === null || Array.isArray(section))
					)
						throw new Error(`Expected ${SETTINGS_SECTION} settings to be an object`);
					root[SETTINGS_SECTION] = {
						...(section === undefined ? {} : (section as JsonObject)),
						[TRADITIONAL_TO_SIMPLIFIED_GROUP]: { mode },
					};
				});
			},
		},
	};
}

export function createTraditionalToSimplifiedFeature(): TraditionalToSimplifiedFeature {
	let activeSessionId: string | undefined;
	let enabled = true;
	let handlerRegistered = false;
	return {
		start(runtime) {
			activeSessionId = runtime.ctx.sessionManager.getSessionId();
			if (handlerRegistered) return;
			handlerRegistered = true;
			runtime.pi.on("input", (event, ctx) => {
				if (!enabled || activeSessionId !== ctx.sessionManager.getSessionId()) return;
				const converted = convertInputText(event.text);
				return converted === event.text ? undefined : { action: "transform", text: converted };
			});
		},
		dispose(sessionId) {
			if (activeSessionId === sessionId) activeSessionId = undefined;
		},
		setEnabled(value) {
			enabled = value;
		},
	};
}
