import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export default function piInturl(pi: ExtensionAPI) {
	registerPathShortcutExpansion(pi);
}
const TMP_SCHEME = "tmp://";

export const PATH_SHORTCUT_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit"] as const;

export interface PathShortcutSettings {
	enabled: boolean;
	tmpEnabled: boolean;
	enabledTools: readonly string[];
}

export interface PathShortcutOptions {
	tmpRoot?: string;
}

export type PathShortcutExpansionResult =
	| { changed: true; path: string }
	| { changed: false; path: string }
	| { error: string };

export const DEFAULT_PATH_SHORTCUT_SETTINGS: PathShortcutSettings = {
	enabled: true,
	tmpEnabled: true,
	enabledTools: PATH_SHORTCUT_TOOL_NAMES,
};

export function expandPathShortcut(
	path: string,
	settings: PathShortcutSettings = DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): PathShortcutExpansionResult {
	if (!settings.enabled) return { changed: false, path };
	if (!path.startsWith(TMP_SCHEME)) return { changed: false, path };
	if (!settings.tmpEnabled) return { changed: false, path };

	const expanded = expandTmpPath(path, options.tmpRoot ?? tmpdir());
	return typeof expanded === "string" ? { changed: true, path: expanded } : expanded;
}

export function applyPathShortcutExpansion(
	event: Pick<ToolCallEvent, "input" | "toolName">,
	settings: PathShortcutSettings = DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): ToolCallEventResult | undefined {
	if (!settings.enabledTools.includes(event.toolName)) return undefined;
	const input = event.input as Record<string, unknown>;
	const path = input.path;
	if (typeof path !== "string") return undefined;

	const expanded = expandPathShortcut(path, settings, options);
	if ("error" in expanded) return { block: true, reason: expanded.error };
	if (expanded.changed) input.path = expanded.path;
	return undefined;
}

export function registerPathShortcutExpansion(
	pi: ExtensionAPI,
	getSettings: () => PathShortcutSettings = () => DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): void {
	pi.on("tool_call", (event) => applyPathShortcutExpansion(event, getSettings(), options));
}

function expandTmpPath(input: string, tmpRoot: string): string | { error: string } {
	let decoded: string;
	try {
		decoded = decodeURIComponent(input.slice(TMP_SCHEME.length));
	} catch {
		return { error: `Invalid tmp:// path encoding: ${input}` };
	}

	if (decoded.includes("\0")) return { error: `Invalid tmp:// path: ${input}` };
	const normalized = decoded.replace(/\\/g, "/");
	if (normalized.startsWith("/"))
		return { error: `Absolute paths are not allowed in tmp:// URLs: ${input}` };

	const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		return { error: `Path traversal is not allowed in tmp:// URLs: ${input}` };
	}

	const root = resolve(tmpRoot);
	const expanded = segments.length === 0 ? root : resolve(root, ...segments);
	if (expanded !== root && !expanded.startsWith(root + sep)) {
		return { error: `tmp:// path escapes temp root: ${input}` };
	}

	return expanded;
}
