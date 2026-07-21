import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import OpenCC from "opencc-js/t2cn";
import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../api/settings.js";

export const TRADITIONAL_TO_SIMPLIFIED_GROUP = "traditional-to-simplified";
export const TRADITIONAL_TO_SIMPLIFIED_FIELD = "enabled";

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
		const line = lines[index]!;
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
const SETTINGS_SECTION = "pi-basics";

async function loadSettings(path: string): Promise<JsonObject> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function saveSettings(path: string, root: JsonObject): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

function settingsPath(ctx: HePiContext): string {
	return join(ctx.cwd ?? process.cwd(), ".pi", "settings.json");
}

export function createTraditionalToSimplifiedSettingsProvider(
	options: { readonly onPersisted?: (enabled: boolean) => void } = {},
): HePiSettingsProvider {
	return {
		id: "pi-basics-traditional-to-simplified",
		title: "traditional to simplified",
		origin: "@pi-basics",
		groups: [
			{
				id: TRADITIONAL_TO_SIMPLIFIED_GROUP,
				title: "",
				fields: [
					{
						id: TRADITIONAL_TO_SIMPLIFIED_FIELD,
						label: "traditional to simplified",
						type: "boolean",
						defaultValue: true,
						description: "Convert interactive Traditional Chinese input to Simplified Chinese.",
						parse: (draft) => {
							if (draft === "true") return true;
							if (draft === "false") return false;
							throw new Error("Expected true or false");
						},
					},
				] satisfies readonly HePiSettingField[],
			},
		],
		storage: {
			async load(ctx: HePiContext) {
				const root = await loadSettings(settingsPath(ctx));
				const section = root[SETTINGS_SECTION];
				const values =
					section && typeof section === "object" && !Array.isArray(section)
						? (section as JsonObject)[TRADITIONAL_TO_SIMPLIFIED_GROUP]
						: undefined;
				return values && typeof values === "object" && !Array.isArray(values)
					? { [TRADITIONAL_TO_SIMPLIFIED_GROUP]: values as Record<string, boolean> }
					: undefined;
			},
			async save(state: HePiSettingsState, ctx: HePiContext) {
				const path = settingsPath(ctx);
				const root = await loadSettings(path);
				const section = root[SETTINGS_SECTION];
				const nextSection =
					section && typeof section === "object" && !Array.isArray(section)
						? { ...(section as JsonObject) }
						: {};
				nextSection[TRADITIONAL_TO_SIMPLIFIED_GROUP] = {
					...(state[TRADITIONAL_TO_SIMPLIFIED_GROUP] ?? {}),
				};
				root[SETTINGS_SECTION] = nextSection;
				await saveSettings(path, root);
				options.onPersisted?.(
					state[TRADITIONAL_TO_SIMPLIFIED_GROUP]?.[TRADITIONAL_TO_SIMPLIFIED_FIELD] === true,
				);
			},
		},
		onLoad: async (state) => {
			options.onPersisted?.(
				state[TRADITIONAL_TO_SIMPLIFIED_GROUP]?.[TRADITIONAL_TO_SIMPLIFIED_FIELD] !== false,
			);
		},
		onChange: async (change) => {
			if (change.fieldId !== TRADITIONAL_TO_SIMPLIFIED_FIELD) return;
			options.onPersisted?.(change.value === true);
		},
	};
}

export function createTraditionalToSimplifiedFeature(): TraditionalToSimplifiedFeature {
	let activeSessionId: string | undefined;
	let enabled = true;
	return {
		start(runtime) {
			activeSessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.pi.on("input", (event) => {
				if (!enabled || activeSessionId !== runtime.ctx.sessionManager.getSessionId()) return;
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
