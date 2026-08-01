import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionPageView,
	ExtensionPageViewContext,
	HepiContext,
	HepiSettingField,
	HepiSettingsPanel,
	HepiSettingsProvider,
	HepiSettingsRegistry,
	HepiSettingsState,
	HepiSettingValue,
} from "@hheei/pi-ext-core";
import { combineSettingsProviders } from "./combined.js";

const VISIBLE_ROWS = 10;
const MARQUEE_FRAME_MS = 125;
const MARQUEE_INITIAL_PAUSE_MS = 750;
const MARQUEE_END_PAUSE_MS = 1_500;

interface FieldRow {
	readonly groupId: string;
	readonly field: HepiSettingField;
}

type ListItem =
	| { readonly kind: "group"; readonly id: string; readonly label: string }
	| { readonly kind: "field"; readonly id: string; readonly row: FieldRow }
	| { readonly kind: "panel"; readonly id: string; readonly panel: HepiSettingsPanel };

function cloneState(state: HepiSettingsState): HepiSettingsState {
	return Object.fromEntries(Object.entries(state).map(([group, values]) => [group, { ...values }]));
}

function isValidStoredValue(field: HepiSettingField, value: unknown): value is HepiSettingValue {
	if (value === null || typeof value !== typeof field.defaultValue) return false;
	if (typeof value === "number" && !Number.isFinite(value)) return false;
	return (
		field.options === undefined || field.options.some((option) => Object.is(option.value, value))
	);
}

/** Applies only schema defaults; extra provider-owned data remains round-trippable. */
function mergeDefaults(
	provider: HepiSettingsProvider,
	stored: HepiSettingsState | undefined,
): HepiSettingsState {
	const state = cloneState(stored ?? {});
	for (const group of provider.groups) {
		const values = { ...(state[group.id] ?? {}) };
		for (const field of group.fields) {
			const storedValue = values[field.id];
			values[field.id] = isValidStoredValue(field, storedValue) ? storedValue : field.defaultValue;
			const related = field.tabCycle;
			if (related !== undefined) {
				const relatedValue = values[related.fieldId];
				values[related.fieldId] =
					relatedValue !== undefined &&
					typeof relatedValue === typeof related.defaultValue &&
					related.options.some((option) => Object.is(option.value, relatedValue))
						? relatedValue
						: related.defaultValue;
			}
		}
		state[group.id] = values;
	}
	return state;
}

function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPrintable(input: string): boolean {
	return input !== "" && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input);
}

function rowId(groupId: string, fieldId: string): string {
	return `field:${groupId}:${fieldId}`;
}

function panelId(panel: HepiSettingsPanel): string {
	return `panel:${panel.id}`;
}

function valueFor(row: FieldRow, state: HepiSettingsState): HepiSettingValue {
	return state[row.groupId]?.[row.field.id] ?? row.field.defaultValue;
}

function updateValue(
	state: HepiSettingsState,
	row: FieldRow,
	value: HepiSettingValue,
): HepiSettingsState {
	return {
		...state,
		[row.groupId]: { ...(state[row.groupId] ?? {}), [row.field.id]: value },
	};
}

function cycleOption(
	field: HepiSettingField,
	value: HepiSettingValue,
	direction = 1,
): HepiSettingValue {
	const options = field.options;
	if (options === undefined || options.length === 0)
		throw new Error(`Setting has no options: ${field.id}`);
	const index = options.findIndex((option) => Object.is(option.value, value));
	return (
		options[(Math.max(0, index) + direction + options.length) % options.length]?.value ??
		field.defaultValue
	);
}

function wrap(text: string, width: number): readonly string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	for (const word of text.split(/\s+/u)) {
		const previous = lines.at(-1);
		if (previous === undefined || visibleWidth(`${previous} ${word}`) > width) lines.push(word);
		else lines[lines.length - 1] = `${previous} ${word}`;
	}
	return lines;
}

function pad(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function horizontalViewport(text: string, width: number, offset: number): string {
	let skipped = 0;
	let result = "";
	for (const character of text) {
		const characterWidth = visibleWidth(character);
		if (skipped + characterWidth <= offset) {
			skipped += characterWidth;
			continue;
		}
		result += character;
	}
	return truncateToWidth(result, width);
}

function scrollMarker(index: number, total: number, top: number): string {
	if (total <= VISIBLE_ROWS) return "";
	const track = Math.max(1, VISIBLE_ROWS - 1);
	const thumb = Math.min(track, Math.max(1, Math.ceil((VISIBLE_ROWS / total) * track)));
	const maxTop = Math.max(1, total - VISIBLE_ROWS);
	const thumbTop = Math.round((top / maxTop) * Math.max(0, track - thumb));
	return index >= thumbTop && index < thumbTop + thumb ? "█" : "│";
}

function formattedValue(
	row: FieldRow,
	state: HepiSettingsState,
	surface: "display" | "description",
): string {
	const value = valueFor(row, state);
	const related = row.field.tabCycle;
	const relatedValue =
		related === undefined
			? undefined
			: (state[row.groupId]?.[related.fieldId] ?? related.defaultValue);
	const formatter = surface === "display" ? row.field.formatDisplay : row.field.formatDescription;
	if (formatter !== undefined) return formatter(value as never, relatedValue as never);
	const base = row.field.format?.(value as never) ?? (value === null ? "" : String(value));
	if (related === undefined) return base;
	const label = related.options.find((option) => Object.is(option.value, relatedValue))?.label;
	return `${base}${related.separator ?? " · "}${label ?? String(relatedValue)}`;
}

function allChangedFields(
	provider: HepiSettingsProvider,
	before: HepiSettingsState,
	after: HepiSettingsState,
): readonly FieldRow[] {
	const seen = new Set<string>();
	const result: FieldRow[] = [];
	for (const group of provider.groups) {
		for (const field of group.fields) {
			const candidates = [
				field.id,
				...(field.tabCycle === undefined ? [] : [field.tabCycle.fieldId]),
			];
			for (const fieldId of candidates) {
				const key = `${group.id}:${fieldId}`;
				if (seen.has(key) || Object.is(before[group.id]?.[fieldId], after[group.id]?.[fieldId]))
					continue;
				seen.add(key);
				result.push({ groupId: group.id, field: { ...field, id: fieldId } });
			}
		}
	}
	return result;
}

/**
 * Hosts the migrated Settings transaction. Providers retain schema, storage and
 * live-policy ownership; this page only holds a draft until an explicit flush.
 */
export async function createSettingsPage(
	registry: HepiSettingsRegistry,
	context: ExtensionPageViewContext,
): Promise<ExtensionPageView> {
	const provider = combineSettingsProviders(registry.list());
	const hepiContext: HepiContext = {
		sessionId: "settings",
		cwd: context.command.cwd,
		signal: context.signal,
	};
	const initial = mergeDefaults(provider, await provider.storage.load(hepiContext));
	context.signal.throwIfAborted();
	await provider.onLoad?.(cloneState(initial), hepiContext);
	context.signal.throwIfAborted();

	let theme = context.theme;
	let committed = cloneState(initial);
	let draft = cloneState(initial);
	let search = "";
	let selectedId: string | undefined;
	let scrollTop = 0;
	let editor: Input | undefined;
	let editing: FieldRow | undefined;
	let relatedDraft: HepiSettingValue | undefined;
	let error: string | undefined;
	let closed = false;
	let closing = false;
	let marqueeIdentity: string | undefined;
	let marqueeOffset = 0;
	let marqueeTimer: ReturnType<typeof setTimeout> | undefined;

	const items = (): readonly ListItem[] => {
		const query = search.trim().toLocaleLowerCase();
		const result: ListItem[] = [];
		for (const group of provider.groups) {
			const fields = group.fields.filter((field) => {
				if (!query) return true;
				return `${group.title} ${field.label} ${field.id} ${field.description}`
					.toLocaleLowerCase()
					.includes(query);
			});
			if (fields.length === 0) continue;
			if (group.title) result.push({ kind: "group", id: `group:${group.id}`, label: group.title });
			for (const field of fields)
				result.push({
					kind: "field",
					id: rowId(group.id, field.id),
					row: { groupId: group.id, field },
				});
		}
		for (const panel of provider.panels ?? []) {
			if (!query || `${panel.label ?? ""} ${panel.id}`.toLocaleLowerCase().includes(query))
				result.push({ kind: "panel", id: panelId(panel), panel });
		}
		return result;
	};
	const selectable = (): readonly ListItem[] => items().filter((item) => item.kind !== "group");
	const selectedItem = (): ListItem | undefined => {
		const available = selectable();
		const existing = available.find((item) => item.id === selectedId);
		if (existing !== undefined) return existing;
		selectedId = available[0]?.id;
		return available[0];
	};
	const selectedField = (): FieldRow | undefined => {
		const item = selectedItem();
		return item?.kind === "field" ? item.row : undefined;
	};
	const isEnabled = (row: FieldRow): boolean => row.field.enabled?.(draft) !== false;
	const requestRender = (): void => context.requestRender();
	const stopMarquee = (): void => {
		if (marqueeTimer !== undefined) clearTimeout(marqueeTimer);
		marqueeTimer = undefined;
	};
	const syncMarquee = (row: FieldRow | undefined, labelWidth: number): void => {
		const maxOffset =
			row === undefined ? 0 : Math.max(0, visibleWidth(row.field.label) - labelWidth);
		const identity =
			row === undefined || editing !== undefined || maxOffset === 0
				? undefined
				: `${row.groupId}:${row.field.id}:${labelWidth}`;
		if (identity !== marqueeIdentity) {
			stopMarquee();
			marqueeIdentity = identity;
			marqueeOffset = 0;
		}
		if (identity === undefined || marqueeTimer !== undefined || closed) return;
		const delay =
			marqueeOffset === 0
				? MARQUEE_INITIAL_PAUSE_MS
				: marqueeOffset >= maxOffset
					? MARQUEE_END_PAUSE_MS
					: MARQUEE_FRAME_MS;
		marqueeTimer = setTimeout(() => {
			marqueeTimer = undefined;
			marqueeOffset = marqueeOffset >= maxOffset ? 0 : marqueeOffset + 1;
			requestRender();
		}, delay);
	};
	const persist = async (): Promise<void> => {
		if (JSON.stringify(draft) === JSON.stringify(committed)) return;
		await provider.storage.validate?.(cloneState(draft), hepiContext);
		for (const changed of allChangedFields(provider, committed, draft)) {
			const previousValue = committed[changed.groupId]?.[changed.field.id];
			await provider.onChange?.(
				{
					groupId: changed.groupId,
					fieldId: changed.field.id,
					value: draft[changed.groupId]?.[changed.field.id] ?? changed.field.defaultValue,
					...(previousValue === undefined ? {} : { previousValue }),
					state: cloneState(draft),
				},
				hepiContext,
			);
		}
		await provider.storage.save(cloneState(draft), hepiContext);
		committed = cloneState(draft);
	};
	const cleanup = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		stopMarquee();
		const failures: unknown[] = [];
		try {
			await provider.onClose?.(cloneState(draft), hepiContext);
		} catch (cause: unknown) {
			failures.push(cause);
		}
		try {
			await provider.storage.close?.(hepiContext);
		} catch (cause: unknown) {
			failures.push(cause);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Settings cleanup failed");
	};
	const flushForNavigation = async (): Promise<boolean> => {
		try {
			await persist();
			return true;
		} catch (cause: unknown) {
			error = readableError(cause);
			requestRender();
			return false;
		}
	};
	const closeInteractive = async (): Promise<void> => {
		if (closing || closed) return;
		closing = true;
		if (!(await flushForNavigation())) {
			closing = false;
			return;
		}
		try {
			await cleanup();
			context.requestClose();
		} catch (cause: unknown) {
			closed = false;
			closing = false;
			error = readableError(cause);
			requestRender();
		}
	};
	const move = (offset: number): void => {
		const available = selectable();
		if (available.length === 0) return;
		const index = Math.max(
			0,
			available.findIndex((item) => item.id === selectedId),
		);
		let next = Math.max(0, Math.min(available.length - 1, index + offset));
		while (next >= 0 && next < available.length) {
			const candidate = available[next];
			if (candidate?.kind !== "field" || isEnabled(candidate.row)) break;
			next += offset < 0 ? -1 : 1;
		}
		if (next < 0 || next >= available.length) return;
		selectedId = available[next]?.id;
		requestRender();
	};
	const beginEdit = (): void => {
		const row = selectedField();
		if (row === undefined || !isEnabled(row)) return;
		if (row.field.type === "boolean") {
			draft = updateValue(draft, row, !valueFor(row, draft));
			error = undefined;
			requestRender();
			return;
		}
		editing = row;
		relatedDraft =
			row.field.tabCycle === undefined
				? undefined
				: (draft[row.groupId]?.[row.field.tabCycle.fieldId] ?? row.field.tabCycle.defaultValue);
		editor = new Input();
		editor.setValue(String(valueFor(row, draft) ?? ""));
		editor.handleInput("\x1b[F");
		error = undefined;
		requestRender();
	};
	const cancelEdit = (): void => {
		editor = undefined;
		editing = undefined;
		relatedDraft = undefined;
		error = undefined;
		requestRender();
	};
	const cycleEditor = (direction: number): void => {
		if (editing?.field.type !== "enum" || editor === undefined) return;
		const current = editing.field.parse(editor.getValue());
		editor.setValue(String(cycleOption(editing.field, current, direction)));
		editor.handleInput("\x1b[F");
		requestRender();
	};
	const cycleRelated = (direction: number): void => {
		const row = editing;
		const related = row?.field.tabCycle;
		if (row === undefined || related === undefined) return;
		const field: HepiSettingField = {
			...row.field,
			id: related.fieldId,
			options: related.options,
		};
		relatedDraft = cycleOption(field, relatedDraft ?? related.defaultValue, direction);
		requestRender();
	};
	const commitEdit = async (): Promise<void> => {
		const row = editing;
		if (row === undefined || editor === undefined) return;
		try {
			const value = row.field.parse(editor.getValue());
			const validation = row.field.validate?.(value as never);
			if (validation !== undefined) throw new Error(validation);
			let next = updateValue(draft, row, value);
			const related = row.field.tabCycle;
			if (related !== undefined)
				next = updateValue(
					next,
					{ groupId: row.groupId, field: { ...row.field, id: related.fieldId } },
					relatedDraft ?? related.defaultValue,
				);
			await provider.storage.validate?.(cloneState(next), hepiContext);
			draft = next;
			cancelEdit();
		} catch (cause: unknown) {
			error = readableError(cause);
			requestRender();
		}
	};
	const renderEditor = (width: number): string => {
		const rendered = editor?.render(width)[0] ?? "";
		return rendered.startsWith("> ") ? rendered.slice(2) : rendered;
	};

	return {
		component: {
			render(width: number): string[] {
				const all = items();
				const selected = selectedItem();
				const selectedIndex = all.findIndex((item) => item.id === selected?.id);
				if (selectedIndex >= 0) {
					if (selectedIndex < scrollTop) scrollTop = selectedIndex;
					else if (selectedIndex >= scrollTop + VISIBLE_ROWS)
						scrollTop = selectedIndex - VISIBLE_ROWS + 1;
				}
				scrollTop = Math.min(scrollTop, Math.max(0, all.length - VISIBLE_ROWS));
				const wide = width >= 76;
				const listWidth = wide ? Math.max(34, Math.floor(width * 0.56)) : width;
				const scrollbarWidth = all.length > VISIBLE_ROWS ? 2 : 0;
				const detailWidth = wide ? Math.max(0, width - listWidth - scrollbarWidth - 3) : width;
				const visible = all.slice(scrollTop, scrollTop + VISIBLE_ROWS);
				const valueWidth = Math.min(18, Math.max(8, Math.floor(listWidth * 0.32)));
				const labelWidth = Math.max(8, listWidth - valueWidth - 5);
				syncMarquee(selected?.kind === "field" ? selected.row : undefined, labelWidth);
				const list = [
					`> ${search || "_"}`,
					...visible.map((item, index) => {
						if (item.kind === "group")
							return theme.bold(truncateToWidth(`⧉ ${item.label}`, listWidth));
						if (item.kind === "panel") {
							const label = `${item.id === selected?.id ? "→" : " "} ◈ ${item.panel.label ?? item.panel.id}`;
							return item.id === selected?.id ? theme.fg("accent", theme.bold(label)) : label;
						}
						const enabled = isEnabled(item.row);
						const label =
							item.id === selected?.id && marqueeIdentity !== undefined
								? horizontalViewport(item.row.field.label, labelWidth, marqueeOffset)
								: truncateToWidth(item.row.field.label, labelWidth);
						const row = `${item.id === selected?.id ? "→" : " "} ${pad(label, labelWidth)} ${truncateToWidth(formattedValue(item.row, draft, "display"), valueWidth)}`;
						const styled = !enabled
							? theme.fg("dim", row)
							: item.id === selected?.id
								? theme.fg("accent", theme.bold(row))
								: row;
						const marker = scrollMarker(index + scrollTop, all.length, scrollTop);
						return `${truncateToWidth(styled, listWidth)}${marker ? ` ${theme.fg("dim", marker)}` : ""}`;
					}),
					theme.fg(
						"dim",
						`↕ navigate · ␣ change · ⎋ ${editing === undefined ? (search ? "clear" : "close") : "cancel"}`,
					),
				];
				const detail =
					selected?.kind === "panel"
						? [...selected.panel.render(detailWidth)]
						: selected?.kind === "field"
							? [
									theme.bold(truncateToWidth(selected.row.field.label, detailWidth)),
									"",
									...wrap(selected.row.field.description, detailWidth),
									"",
									theme.fg("muted", `Origin: ${provider.origin ?? provider.id}`),
									"",
									theme.fg(
										"text",
										`Value: ${editing?.groupId === selected.row.groupId && editing.field.id === selected.row.field.id ? renderEditor(Math.max(0, detailWidth - 7)) : truncateToWidth(formattedValue(selected.row, draft, "description"), Math.max(0, detailWidth - 7))}`,
									),
									...(error === undefined ? [] : [theme.fg("error", `Error: ${error}`)]),
								]
							: [
									theme.fg(
										"muted",
										search ? "No matching settings." : "No extension settings are registered.",
									),
								];
				if (!wide) return [...list, "", ...detail].map((line) => truncateToWidth(line, width));
				const count = Math.max(list.length, detail.length);
				return Array.from({ length: count }, (_, index) => {
					const left = pad(truncateToWidth(list[index] ?? "", listWidth), listWidth);
					return `${left}${" ".repeat(scrollbarWidth)}   ${truncateToWidth(detail[index] ?? "", detailWidth)}`;
				});
			},
			handleInput(): void {},
			invalidate(): void {
				const selected = selectedItem();
				if (selected?.kind === "panel") selected.panel.invalidate?.();
				requestRender();
			},
		},
		async handleInput(input: string): Promise<boolean> {
			if (editing !== undefined && editor !== undefined) {
				if (matchesKey(input, Key.escape)) cancelEdit();
				else if (matchesKey(input, Key.enter)) await commitEdit();
				else if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab")))
					cycleRelated(matchesKey(input, Key.tab) ? 1 : -1);
				else if (editing.field.type === "enum" && matchesKey(input, Key.up)) cycleEditor(-1);
				else if (editing.field.type === "enum" && matchesKey(input, Key.down)) cycleEditor(1);
				else if (editing.field.type !== "enum") {
					editor.handleInput(input);
					requestRender();
				}
				return true;
			}
			const selected = selectedItem();
			if (selected?.kind === "panel" && selected.panel.handleInput !== undefined) {
				const handled = await selected.panel.handleInput(input);
				if (handled !== false) {
					requestRender();
					return true;
				}
			}
			if (matchesKey(input, Key.left) || matchesKey(input, Key.right))
				return !(await flushForNavigation());
			if (matchesKey(input, Key.up)) move(-1);
			else if (matchesKey(input, Key.down)) move(1);
			else if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) beginEdit();
			else if (matchesKey(input, Key.backspace)) {
				search = search.slice(0, -1);
				requestRender();
			} else if (matchesKey(input, Key.escape)) {
				if (search) {
					search = "";
					requestRender();
				} else await closeInteractive();
			} else if (isPrintable(input)) {
				search += input;
				requestRender();
			}
			return true;
		},
		onThemeChange(nextTheme: Theme): void {
			theme = nextTheme;
		},
		async close(): Promise<void> {
			await cleanup();
		},
	};
}
