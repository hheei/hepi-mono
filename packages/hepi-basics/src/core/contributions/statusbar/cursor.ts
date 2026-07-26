import type { HePiSettingsProvider, HePiSettingValue } from "../../api/settings.js";
import { createJsonSectionSettingsStorage } from "../../runtime/json-settings.js";

export const CURSOR_SHAPES = ["bar", "block", "hollow", "underline"] as const;
export type CursorShape = (typeof CURSOR_SHAPES)[number];

export interface CursorOptions {
	readonly shape: CursorShape;
	readonly blink: boolean;
}

export const DEFAULT_CURSOR_OPTIONS: CursorOptions = { shape: "block", blink: false };
const CURSOR_CODES: Record<CursorShape, readonly [number, number]> = {
	bar: [5, 6],
	block: [1, 2],
	hollow: [7, 8],
	underline: [3, 4],
};

export function parseCursorShape(value: unknown): CursorShape | undefined {
	switch (value) {
		case "bar":
		case "block":
		case "hollow":
		case "underline":
			return value;
		default:
			return undefined;
	}
}

export function cursorOptionsFromState(
	state: Readonly<Record<string, HePiSettingValue>> | undefined,
): CursorOptions {
	return {
		shape: parseCursorShape(state?.shape) ?? DEFAULT_CURSOR_OPTIONS.shape,
		blink: state?.blink === true,
	};
}

export function cursorEscape(options: CursorOptions): string {
	const codes = CURSOR_CODES[options.shape];
	const code = codes[options.blink ? 0 : 1];
	const fallback = options.blink ? 1 : 2;
	return options.shape === "hollow" ? `\x1b[${fallback} q\x1b[${code} q` : `\x1b[${code} q`;
}

export function createCursorSettingsProvider(options: {
	readonly path?: string;
	readonly onPersisted?: (options: CursorOptions) => void;
}): HePiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: "pi-basics",
		group: "cursor",
	});
	return {
		id: "pi-basics-cursor",
		title: "Pi Basics",
		origin: "@hheei/hepi-basics",
		description: "Terminal cursor appearance.",
		groups: [
			{
				id: "cursor",
				title: "Cursor",
				fields: [
					{
						id: "shape",
						label: "Cursor shape",
						type: "enum",
						defaultValue: DEFAULT_CURSOR_OPTIONS.shape,
						description: "Choose the terminal cursor shape used while editing text.",
						options: [
							{ value: "bar", label: "Bar" },
							{ value: "block", label: "Block" },
							{ value: "hollow", label: "Hollow" },
							{ value: "underline", label: "Underline" },
						],
						parse: (value) => parseCursorShape(value) ?? DEFAULT_CURSOR_OPTIONS.shape,
					},
					{
						id: "blink",
						label: "Blink cursor",
						type: "boolean",
						defaultValue: DEFAULT_CURSOR_OPTIONS.blink,
						description: "Enable terminal cursor blinking while the editor has focus.",
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage: {
			async load(ctx) {
				const state = await storage.load(ctx);
				return state?.cursor ? { cursor: state.cursor } : undefined;
			},
			async save(state, ctx) {
				const values = state.cursor;
				const cursor = cursorOptionsFromState(values);
				await storage.save({ cursor: { shape: cursor.shape, blink: cursor.blink } }, ctx);
				options.onPersisted?.(cursor);
			},
		},
		onLoad: async (state) => {
			options.onPersisted?.(cursorOptionsFromState(state.cursor));
		},
	};
}
