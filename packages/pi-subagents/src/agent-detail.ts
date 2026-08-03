/**
 * agent-detail.ts — Contributor-owned Loadout detail editor for custom Markdown agents.
 *
 * The detail is a small inline form over the agent's YAML frontmatter. Text fields
 * (identity, description) edit in memory; Enter persists all pending edits by
 * rewriting the frontmatter while preserving the body and unknown keys, then reloads
 * the catalog. The model/thinking pair reuses the Settings cycler (`tabCycle`
 * semantics): Enter opens a single selector on the model options, Up/Down move
 * between them, Tab cycles the thinking value in place, Enter applies both and
 * saves, Esc cancels. Both lists lead with `inherit` (unset). Toggle fields
 * (enabled) persist immediately on Space. The Body row first flushes pending
 * edits, then opens the external editor and reloads after it exits. The caller
 * owns the catalog reload; this module only reports it through `onChanged` and
 * surfaces failures through `notify`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type HepiModelSelectionRegistry,
	hepiAuthenticatedModelSelectionOptions,
	type LoadoutResourceDetail,
} from "@hheei/pi-ext-core";
import type { AgentConfig } from "./types.js";

/** Frontmatter keys the detail may rewrite; all other keys are preserved untouched. */
const EDITABLE_AGENT_KEYS = [
	"display_name",
	"description",
	"model",
	"thinking",
	"enabled",
	"prompt_mode",
] as const;

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const FIRST_FIELD: DetailField = { id: "identity", kind: "text" };
const DETAIL_FIELDS: readonly DetailField[] = [
	FIRST_FIELD,
	{ id: "description", kind: "text" },
	{ id: "model", kind: "select" },
	{ id: "thinking", kind: "select" },
	{ id: "enabled", kind: "toggle" },
	{ id: "body", kind: "action" },
];

type FieldId = "identity" | "description" | "model" | "thinking" | "enabled" | "body";
type FieldKind = "text" | "select" | "toggle" | "action";

interface DetailField {
	readonly id: FieldId;
	readonly kind: FieldKind;
}

/** The selector's sentinel for an unset value; saves as an omitted key. */
const INHERIT = "inherit";

/** Minimal model identity needed to build the cycler option list. */
interface ModelCandidate {
	readonly provider: string;
	readonly id: string;
}

/**
 * The detail's editable snapshot. It is deliberately not `AgentConfig`: `thinking`
 * must also carry `"off"`, which the loader casts away at its own boundary.
 */
interface AgentDraft {
	readonly displayName: string | undefined;
	readonly description: string;
	readonly model: string | undefined;
	readonly thinking: ModelThinkingLevel | undefined;
	readonly enabled: boolean;
	readonly promptMode: AgentConfig["promptMode"];
	readonly source: AgentConfig["source"];
	readonly isDefault: boolean;
}

function draftFromConfig(config: AgentConfig): AgentDraft {
	return {
		displayName: config.displayName,
		description: config.description,
		model: config.model,
		thinking: config.thinking,
		enabled: config.enabled !== false,
		promptMode: config.promptMode,
		source: config.source,
		isDefault: config.isDefault === true,
	};
}

/** Resolves the `.md` file backing a custom agent, honoring the loader's dir order. */
export function agentMarkdownPath(name: string, source: AgentConfig["source"]): string | undefined {
	const dirs =
		source === "global"
			? [join(getAgentDir(), "agents")]
			: [join(process.cwd(), ".pi", "agents"), join(process.cwd(), ".agents", "agents")];
	for (const dir of dirs) {
		const path = join(dir, `${name}.md`);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function yamlValue(value: string | boolean | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

/**
 * Serializes the editable values back into the agent file's YAML frontmatter.
 * Unknown frontmatter keys and the body (including its trailing newline) survive
 * byte-for-byte. A file without a frontmatter block gets one prepended.
 */
export function rewriteAgentMarkdown(
	path: string,
	values: Readonly<Record<string, string | boolean | undefined>>,
): void {
	const original = readFileSync(path, "utf8");
	// Detect the block structurally: `parseFrontmatter` treats a missing block as
	// an empty object, so its return cannot distinguish "no frontmatter".
	if (!original.startsWith("---")) {
		const lines = EDITABLE_AGENT_KEYS.map((key) => {
			const value = yamlValue(values[key]);
			return value === undefined ? undefined : `${key}: ${value}`;
		}).filter((line): line is string => line !== undefined);
		writeFileSync(path, `---\n${lines.join("\n")}\n---\n${original}`, "utf8");
		return;
	}
	// Validates the existing block; malformed YAML surfaces as an Error.
	parseFrontmatter<Record<string, unknown>>(original);
	const start = original.startsWith("---") ? original.indexOf("\n") + 1 : -1;
	const end = start >= 0 ? original.indexOf("\n---", start) : -1;
	const existing = start >= 0 && end >= 0 ? original.slice(start, end) : "";
	const managed = new Set<string>(EDITABLE_AGENT_KEYS);
	const kept = existing
		.split("\n")
		.filter((line) => line !== "" && !managed.has(line.match(/^([A-Za-z0-9_-]+):/)?.[1] ?? ""));
	const lines = [...kept];
	for (const key of EDITABLE_AGENT_KEYS) {
		const value = yamlValue(values[key]);
		if (value !== undefined) lines.push(`${key}: ${value}`);
	}
	const body = start >= 0 && end >= 0 ? original.slice(end + "\n---".length) : original;
	writeFileSync(path, `---\n${lines.join("\n")}\n---${body}`, "utf8");
}

/** The detail surface plus a catalog-reload refresh hook owned by the caller. */
export interface AgentDetail extends LoadoutResourceDetail {
	/** Replaces the snapshot after the caller reloads the catalog from disk. */
	refresh(config: AgentConfig): void;
}

/**
 * Builds the Loadout detail editor for one custom agent. The returned surface is
 * single-instance per agent: the caller must keep it across fingerprint changes so
 * an open Loadout panel keeps its selection while the list metadata is refreshed.
 */
export function createAgentDetail(
	pi: ExtensionAPI,
	name: string,
	initial: AgentConfig,
	modelRegistry: HepiModelSelectionRegistry<ModelCandidate> | undefined,
	onChanged: () => void,
	notify: (message: string) => void,
): AgentDetail {
	let draft = draftFromConfig(initial);
	let selected = 0;
	// The cycler state: while `selectingModel` is true, Up/Down move through the
	// model options, Tab cycles `thinkingDraft` in place, and Enter applies both
	// through `save()`. `thinkingDraft` is separate from `draft` so Esc can
	// discard the in-progress cycle without touching the persisted snapshot.
	let selectingModel = false;
	let selectIndex = 0;
	let thinkingDraft: ModelThinkingLevel | undefined;
	const field = (): DetailField => DETAIL_FIELDS[selected] ?? FIRST_FIELD;
	const textValue = (): string => {
		const id = field().id;
		if (id === "identity") return draft.displayName ?? "";
		return draft.description;
	};
	const setText = (value: string): void => {
		const id = field().id;
		if (id === "identity") draft = { ...draft, displayName: value };
		else draft = { ...draft, description: value };
	};
	/**
	 * Model cycler options: `inherit` first, then the `provider/model` list
	 * filtered through `hasConfiguredAuth` — only authenticated models are
	 * offered, kept in alphabetical order including an authenticated current
	 * value. A current value absent from that list (fuzzy names such as
	 * "haiku", or an unauthenticated provider) is preserved and prepended.
	 */
	const modelChoices = (): readonly string[] => {
		const current = draft.model?.trim() ?? "";
		const available = hepiAuthenticatedModelSelectionOptions(
			modelRegistry ?? { hasConfiguredAuth: () => false },
		)
			.map((option) => option.value)
			.filter((ref) => ref !== "")
			.sort((left, right) => left.localeCompare(right));
		if (current !== "" && !available.includes(current)) {
			return [INHERIT, current, ...available];
		}
		return [INHERIT, ...available];
	};
	/** Thinking cycle order; `inherit` is index 0, so one Tab per wrap. */
	const thinkingChoices = (): readonly string[] => [INHERIT, ...THINKING_LEVELS];
	const openSelector = (): void => {
		selectingModel = true;
		thinkingDraft = draft.thinking;
		const idx = modelChoices().indexOf(draft.model ?? INHERIT);
		selectIndex = idx >= 0 ? idx : 0;
	};
	/** Cycles the thinking value; mirrors the Settings cycler's modulo wrap. */
	const cycleThinking = (direction: number): void => {
		const choices = thinkingChoices();
		const idx = choices.indexOf(thinkingDraft ?? INHERIT);
		const next =
			choices[(Math.max(0, idx) + direction + choices.length) % choices.length] ?? INHERIT;
		thinkingDraft = next === INHERIT ? undefined : (next as ModelThinkingLevel);
	};
	/** Persists the current snapshot; returns false (with a notification) on failure. */
	const save = (): boolean => {
		const path = agentMarkdownPath(name, draft.source);
		if (path === undefined) return false;
		// Model values are resolved tolerantly at spawn time (fuzzy names such as
		// "haiku", dotted/dashed versions, provider fallback), so the editor only
		// normalizes whitespace and must not second-guess valid configurations.
		const model = (draft.model ?? "").trim();
		const displayName = (draft.displayName ?? "").trim();
		const values: Record<string, string | boolean | undefined> = {
			display_name: displayName === "" ? undefined : displayName,
			description: draft.description,
			model: model === "" ? undefined : model,
			thinking: draft.thinking,
			enabled: draft.enabled,
			prompt_mode: draft.promptMode,
		};
		try {
			rewriteAgentMarkdown(path, values);
		} catch (error) {
			notify(
				`Agent changes were not saved: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
		draft = {
			...draft,
			displayName: displayName === "" ? undefined : displayName,
			model: model === "" ? undefined : model,
		};
		onChanged();
		return true;
	};
	return {
		render(width: number): readonly string[] {
			const path = agentMarkdownPath(name, draft.source);
			const currentModel = selectingModel
				? (modelChoices()[selectIndex] ?? INHERIT)
				: (draft.model ?? INHERIT);
			const lines = [
				`Identity: ${draft.displayName ?? name}`,
				`Description: ${draft.description}`,
				`Model: ${currentModel}`,
				`Thinking: ${(selectingModel ? thinkingDraft : draft.thinking) ?? INHERIT}`,
				`Enabled: ${draft.enabled ? "yes" : "no"}`,
				`Default agent: ${draft.isDefault ? "yes" : "no"}`,
				`Markdown: ${path ?? "unavailable"}`,
				selectingModel
					? "↑/↓ choose · Tab cycle thinking · Enter save · Esc cancel"
					: "↑/↓ select · Enter edit/save · Space toggle · Esc back",
			];
			return lines.map((line, index) =>
				truncateToWidth(`${index === selected ? "→ " : "  "}${line}`, Math.max(0, width)),
			);
		},
		async handleInput(input: string): Promise<boolean> {
			if (selectingModel) {
				if (matchesKey(input, Key.up)) {
					selectIndex = (selectIndex - 1 + modelChoices().length) % modelChoices().length;
					return true;
				}
				if (matchesKey(input, Key.down)) {
					selectIndex = (selectIndex + 1) % modelChoices().length;
					return true;
				}
				if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab"))) {
					cycleThinking(matchesKey(input, Key.tab) ? 1 : -1);
					return true;
				}
				if (matchesKey(input, Key.enter)) {
					selectingModel = false;
					const value = modelChoices()[selectIndex] ?? INHERIT;
					draft = {
						...draft,
						model: value === INHERIT ? undefined : value,
						thinking: thinkingDraft,
					};
					save();
					return true;
				}
				if (matchesKey(input, Key.escape)) {
					selectingModel = false;
					return true;
				}
				// Everything else is consumed while the selector is open.
				return true;
			}
			if (matchesKey(input, Key.up)) {
				selected = Math.max(0, selected - 1);
				return true;
			}
			if (matchesKey(input, Key.down)) {
				selected = Math.min(DETAIL_FIELDS.length - 1, selected + 1);
				return true;
			}
			if (matchesKey(input, Key.space)) {
				if (field().kind === "toggle") {
					draft = { ...draft, enabled: !draft.enabled };
					save();
				}
				return true;
			}
			if (matchesKey(input, Key.enter)) {
				if (field().kind === "select") {
					openSelector();
				} else if (field().kind === "action") {
					// Pending text edits must reach the file before the editor opens,
					// otherwise opening the body discards them.
					if (!save()) return true;
					const path = agentMarkdownPath(name, draft.source);
					if (path === undefined) return true;
					const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
					const result = await pi.exec(editor, [path]);
					if (result.code !== 0)
						notify(`Editor exited with status ${result.code}; the body may be unchanged.`);
					onChanged(); // refresh the catalog and this detail's snapshot after external edits
				} else {
					save();
				}
				return true;
			}
			if (matchesKey(input, Key.backspace)) {
				if (field().kind === "text") setText(removeLastCodePoint(textValue()));
				return true;
			}
			if (input && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input)) {
				if (field().kind === "text") setText(`${textValue()}${input}`);
				return true;
			}
			return false;
		},
		refresh(next: AgentConfig): void {
			draft = draftFromConfig(next);
		},
	};
}

function removeLastCodePoint(value: string): string {
	return Array.from(value).slice(0, -1).join("");
}
