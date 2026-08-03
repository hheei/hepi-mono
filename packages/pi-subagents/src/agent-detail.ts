/**
 * agent-detail.ts — Contributor-owned Loadout detail editor for custom Markdown agents.
 *
 * The detail is a small inline form over the agent's YAML frontmatter. All edits
 * (text, cycler picks, body) are buffered per Loadout scope and only written
 * when the Loadout page closes (`flush`), never per keystroke; the model/thinking
 * pair reuses the Settings cycler (`tabCycle` semantics): Enter opens a single
 * selector on the model options, Up/Down move between them, Tab cycles the
 * thinking value in place (off…max, no `inherit`), Enter confirms both, Esc
 * cancels. The form renders as two aligned columns (label / value) like the
 * Settings field list, the focused row gets the accent treatment, and the Body
 * action row advertises the external editor as its value ("open in editor").
 * The Body row opens the Pi host's native multi-line editor (`ui.editor`), which
 * returns the edited text or `undefined` on cancel; the result is stored in the
 * buffered draft — nothing touches the target file until flush. Project-scope edits
 * always target `<cwd>/.pi/agents/<name>.md` (materializing a clone when
 * missing); Global-scope edits target the agent's own backing file. Agent
 * activation is owned by the Loadout policy under `agent:<name>`, never by
 * this Markdown, so there is no enabled field here. The caller owns the
 * catalog reload; this module only reports it through `onChanged` and surfaces
 * failures through `notify`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type HepiModelSelectionRegistry,
	hepiAuthenticatedModelSelectionOptions,
	hepiThinkingGlyph,
	type LoadoutResourceDetail,
} from "@hheei/pi-ext-core";
import type { AgentConfig } from "./types.js";

/** Frontmatter keys the detail may rewrite; all other keys are preserved untouched. */
const EDITABLE_AGENT_KEYS = [
	"display_name",
	"description",
	"model",
	"thinking",
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
	{ id: "body", kind: "action" },
];

type FieldId = "identity" | "description" | "model" | "body";
type FieldKind = "text" | "select" | "action";

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
	readonly promptMode: AgentConfig["promptMode"];
	readonly builtinToolNames: readonly string[] | undefined;
	readonly systemPrompt: string;
	readonly source: AgentConfig["source"];
	readonly isDefault: boolean;
}

function draftFromConfig(config: AgentConfig): AgentDraft {
	return {
		displayName: config.displayName,
		description: config.description,
		model: config.model,
		thinking: config.thinking,
		promptMode: config.promptMode,
		builtinToolNames: config.builtinToolNames,
		systemPrompt: config.systemPrompt,
		source: config.source,
		isDefault: config.isDefault === true,
	};
}

/**
 * Writes a full agent Markdown file (managed frontmatter keys plus the body).
 * Used to clone a built-in agent into the project agents dir on first save;
 * `rewriteAgentMarkdown` is for files that already exist. `tools` is included
 * because omitting it would silently widen a built-in agent's allowlist to all
 * tools (e.g. a read-only Explore clone would gain write tools).
 */
export function writeAgentMarkdown(
	path: string,
	values: Readonly<Record<string, string | boolean | undefined>>,
	body: string,
): void {
	const lines = [...EDITABLE_AGENT_KEYS, "tools"]
		.map((key) => {
			const value = yamlValue(values[key]);
			return value === undefined ? undefined : `${key}: ${value}`;
		})
		.filter((line): line is string => line !== undefined);
	writeFileSync(path, `---\n${lines.join("\n")}\n---\n${body}`, "utf8");
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

function pad(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

/**
 * Serializes the editable values back into the agent file's YAML frontmatter.
 * Unknown frontmatter keys and the body (including its trailing newline) survive
 * byte-for-byte. A file without a frontmatter block gets one prepended. When
 * `bodyOverride` is supplied (a buffered body edit), it replaces the body and
 * is written after a single leading newline.
 */
export function rewriteAgentMarkdown(
	path: string,
	values: Readonly<Record<string, string | boolean | undefined>>,
	bodyOverride?: string,
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
	const body =
		bodyOverride !== undefined
			? `\n${bodyOverride}`
			: start >= 0 && end >= 0
				? original.slice(end + "\n---".length)
				: original;
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
	name: string,
	initial: AgentConfig,
	modelRegistry: HepiModelSelectionRegistry<ModelCandidate> | undefined,
	openBodyEditor: (title: string, prefill: string) => Promise<string | undefined>,
	onChanged: () => void,
	notify: (message: string) => void,
): AgentDetail {
	/**
	 * One buffered draft per Loadout scope: Global edits target the agent's own
	 * backing file, Project edits target <cwd>/.pi/agents/<name>.md. Keeping
	 * them separate means a Global edit followed by a Project edit of the same
	 * agent flushes to both files on close, instead of the last scope winning.
	 */
	interface ScopeDraft {
		readonly scope: "global" | "project";
		draft: AgentDraft;
		dirty: boolean;
		/** True once the Body row rewrote the buffered system prompt. */
		bodyEdited: boolean;
	}
	let base: AgentDraft = draftFromConfig(initial);
	const byScope = new Map<"global" | "project", ScopeDraft>();
	let scope: "global" | "project" = "global";
	const current = (): ScopeDraft => {
		let entry = byScope.get(scope);
		if (entry === undefined) {
			entry = { scope, draft: base, dirty: false, bodyEdited: false };
			byScope.set(scope, entry);
		}
		return entry;
	};
	let selected = 0;
	let theme: Theme | undefined;
	// Edits are buffered until the Loadout page closes: typing, cycler picks,
	// and selector confirms only mutate the active scope's draft and mark it
	// dirty. `flush()` is the single point that writes files, so leaving the
	// panel applies every buffered scope's changes at once instead of
	// rewriting the Markdown per keystroke.
	// The cycler state: while `selectingModel` is true, Up/Down move through the
	// model options, Tab cycles `thinkingDraft` in place (off…max only; the
	// `inherit` state is the untouched buffer and is not offered in the cycle),
	// and Enter confirms both. `thinkingDraft` is separate from `draft` so Esc
	// can discard the in-progress cycle without touching the buffered snapshot.
	let selectingModel = false;
	let selectIndex = 0;
	let thinkingDraft: ModelThinkingLevel | undefined;
	const field = (): DetailField => DETAIL_FIELDS[selected] ?? FIRST_FIELD;
	/**
	 * The rendered form mirrors the Settings field list: a left label column and
	 * a right value column. The Model row is the combined model/thinking entry:
	 * the thinking glyph (only when a level is pinned) precedes the model
	 * value. The Body action row advertises the external editor as its value
	 * ("open in editor"). The focused row gets the accent treatment like
	 * Settings; a built-in agent's Identity row is read-only and rendered dim.
	 */
	const rows = (): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
		const draft = current().draft;
		const model = selectingModel
			? (modelChoices()[selectIndex] ?? INHERIT)
			: (draft.model ?? INHERIT);
		const thinking = selectingModel ? thinkingDraft : draft.thinking;
		const glyph = thinking === undefined ? "" : `${hepiThinkingGlyph(thinking)} `;
		return [
			{ label: "Identity", value: draft.displayName ?? name },
			{ label: "Description", value: draft.description },
			{ label: "Model", value: `${glyph}${model}` },
			{ label: "Body", value: "open in editor" },
		];
	};
	const textValue = (): string => {
		const draft = current().draft;
		const id = field().id;
		if (id === "identity") return draft.displayName ?? "";
		return draft.description;
	};
	const setText = (value: string): void => {
		const entry = current();
		const draft = entry.draft;
		const id = field().id;
		// A built-in agent's identity is owned by its definition, not the user;
		// the row renders dim and edits are discarded.
		if (id === "identity" && draft.isDefault) return;
		if (id === "identity") {
			entry.draft = { ...draft, displayName: value };
			entry.dirty = true;
			return;
		}
		entry.draft = { ...draft, description: value };
		entry.dirty = true;
	};
	/**
	 * Model cycler options: `inherit` first, then the `provider/model` list
	 * filtered through `hasConfiguredAuth` — only authenticated models are
	 * offered, kept in alphabetical order including an authenticated current
	 * value. A current value absent from that list (fuzzy names such as
	 * "haiku", or an unauthenticated provider) is preserved and prepended.
	 */
	const modelChoices = (): readonly string[] => {
		const currentModel = current().draft.model?.trim() ?? "";
		const available = hepiAuthenticatedModelSelectionOptions(
			modelRegistry ?? { hasConfiguredAuth: () => false },
		)
			.map((option) => option.value)
			.filter((ref) => ref !== "")
			.sort((left, right) => left.localeCompare(right));
		if (currentModel !== "" && !available.includes(currentModel)) {
			return [INHERIT, currentModel, ...available];
		}
		return [INHERIT, ...available];
	};
	const openSelector = (): void => {
		selectingModel = true;
		thinkingDraft = current().draft.thinking;
		const idx = modelChoices().indexOf(current().draft.model ?? INHERIT);
		selectIndex = idx >= 0 ? idx : 0;
	};
	/**
	 * Cycles the thinking value within off…max (never `inherit`): the first Tab
	 * from the untouched inherit buffer starts at off, and further Tabs wrap
	 * within the levels. Confirming without Tab keeps `inherit` intact.
	 */
	const cycleThinking = (direction: number): void => {
		const current = thinkingDraft;
		if (current === undefined) {
			thinkingDraft = THINKING_LEVELS[direction > 0 ? 0 : THINKING_LEVELS.length - 1];
			return;
		}
		const idx = THINKING_LEVELS.indexOf(current);
		thinkingDraft =
			THINKING_LEVELS[(idx + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length];
	};
	/** Writes one scope's buffered snapshot to that scope's target file. */
	const applyPending = (entry: ScopeDraft): boolean => {
		const { draft } = entry;
		let path: string | undefined;
		let cloned = false;
		if (entry.scope === "project") {
			// The project agents dir is authoritative for project-scope edits; a
			// missing file (global or built-in agent) is materialized there with
			// the current system prompt as the body, never touching the original.
			path = join(process.cwd(), ".pi", "agents", `${name}.md`);
			cloned = !existsSync(path);
			mkdirSync(dirname(path), { recursive: true });
		} else {
			path = agentMarkdownPath(name, draft.source);
		}
		if (path === undefined && draft.isDefault) {
			// A built-in agent has no backing file; the first save materializes
			// one in the project agents dir so it becomes an editable override.
			// The clone carries the built-in system prompt as the body plus the
			// current editable values and the tool allowlist, so nothing is
			// silently dropped or widened.
			const dir = join(process.cwd(), ".pi", "agents");
			mkdirSync(dir, { recursive: true });
			path = join(dir, `${name}.md`);
			cloned = true;
		}
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
			prompt_mode: draft.promptMode,
			tools: draft.builtinToolNames?.join(", "),
		};
		try {
			if (cloned) writeAgentMarkdown(path, values, draft.systemPrompt);
			else rewriteAgentMarkdown(path, values, entry.bodyEdited ? draft.systemPrompt : undefined);
		} catch (error) {
			notify(
				`Agent changes were not saved: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
		entry.draft = {
			...draft,
			displayName: displayName === "" ? undefined : displayName,
			model: model === "" ? undefined : model,
		};
		return true;
	};
	/**
	 * Persists every dirty scope when the Loadout page closes: all snapshots
	 * are written first, then the catalog reload is triggered once. Reloading
	 * inside the per-scope loop would refresh this detail (clearing the
	 * buffers) before the remaining scopes are written.
	 */
	const flush = (): void => {
		let wrote = false;
		for (const entry of byScope.values()) {
			if (!entry.dirty) continue;
			if (applyPending(entry)) {
				entry.dirty = false;
				wrote = true;
			}
		}
		if (wrote) onChanged();
	};
	const backingPath = (): string =>
		scope === "project"
			? join(process.cwd(), ".pi", "agents", `${name}.md`)
			: (agentMarkdownPath(name, base.source) ??
				// A built-in agent has no file yet; report where a first save would
				// clone it (the project agents dir), not a dead "unavailable".
				join(process.cwd(), ".pi", "agents", `${name}.md`));
	const detail: AgentDetail = {
		render(width: number): readonly string[] {
			const rendered = rows();
			// Mirror the Settings field list: the label column never exceeds 55%
			// of the panel width so the value column keeps room at narrow sizes.
			const widest = Math.max(...rendered.map((row) => visibleWidth(row.label)));
			const labelWidth = Math.min(widest, Math.max(8, Math.floor(Math.max(0, width) * 0.55)));
			const valueWidth = Math.max(1, Math.max(0, width) - labelWidth - 4);
			return rendered.map((row, index) => {
				const focused = index === selected && index < DETAIL_FIELDS.length;
				const readonlyIdentity = index === 0 && current().draft.isDefault;
				const line = `${focused ? "→ " : "  "}${pad(row.label, labelWidth)}  ${truncateToWidth(row.value, valueWidth)}`;
				const truncated = truncateToWidth(line, Math.max(0, width));
				// The focused row is always accent; a built-in agent's read-only
				// Identity is only dimmed while unfocused.
				if (readonlyIdentity && !focused) return theme?.fg("dim", truncated) ?? truncated;
				if (!focused || theme === undefined) return truncated;
				return theme.fg("accent", theme.bold(truncated));
			});
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
					const entry = current();
					entry.draft = {
						...entry.draft,
						model: value === INHERIT ? undefined : value,
						thinking: thinkingDraft,
					};
					entry.dirty = true;
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
			if (matchesKey(input, Key.enter)) {
				if (field().kind === "select") {
					openSelector();
				} else if (field().kind === "action") {
					// The Pi host's native editor returns the edited text (or
					// undefined when cancelled); the result goes into the buffered
					// draft, so nothing touches the target file until flush().
					const entry = current();
					try {
						const edited = await openBodyEditor(`${name} — agent body`, entry.draft.systemPrompt);
						if (edited !== undefined) {
							entry.draft = { ...entry.draft, systemPrompt: edited };
							entry.dirty = true;
							entry.bodyEdited = true;
						}
					} catch (error) {
						// No usable editor surface: tell the user instead of hanging.
						notify(
							`Could not open the editor: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
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
			// Safe to drop the buffers here: refresh only runs after a reload
			// that this detail's own flush triggered (all scopes already on
			// disk) or after external file edits that win over buffered ones.
			base = draftFromConfig(next);
			byScope.clear();
		},
		flush,
		path: backingPath(),
		onScopeChange(next: "global" | "project"): void {
			scope = next;
			detail.path = backingPath();
		},
		onThemeChange(nextTheme: Theme): void {
			theme = nextTheme;
		},
	};
	return detail;
}

function removeLastCodePoint(value: string): string {
	return Array.from(value).slice(0, -1).join("");
}
