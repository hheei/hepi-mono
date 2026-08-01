import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionPageView,
	ExtensionPageViewContext,
	HepiContext,
	HepiSettingField,
	HepiSettingsProvider,
	HepiSettingsRegistry,
	HepiSettingsState,
	HepiSettingValue,
} from "@hheei/pi-ext-core";

interface ProviderRecord {
	readonly provider: HepiSettingsProvider;
	initial: HepiSettingsState;
	current: HepiSettingsState;
}

interface FieldRow {
	readonly providerId: string;
	readonly groupId: string;
	readonly field: HepiSettingField;
}

function cloneState(state: HepiSettingsState): HepiSettingsState {
	return Object.fromEntries(
		Object.entries(state).map(([groupId, values]) => [groupId, { ...values }]),
	);
}

function mergeDefaults(
	provider: HepiSettingsProvider,
	stored: HepiSettingsState | undefined,
): HepiSettingsState {
	const current = stored ?? {};
	return Object.fromEntries(
		provider.groups.map((group) => [
			group.id,
			Object.fromEntries(
				group.fields.map((field) => [
					field.id,
					current[group.id]?.[field.id] ?? field.defaultValue,
				]),
			),
		]),
	);
}

function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPrintable(input: string): boolean {
	return input !== "" && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input);
}

function valueFor(row: FieldRow, record: ProviderRecord): HepiSettingValue {
	return record.current[row.groupId]?.[row.field.id] ?? row.field.defaultValue;
}

function isDirty(record: ProviderRecord): boolean {
	return JSON.stringify(record.current) !== JSON.stringify(record.initial);
}

function fieldRows(
	records: ReadonlyMap<string, ProviderRecord>,
	search: string,
): readonly FieldRow[] {
	const query = search.trim().toLocaleLowerCase();
	return [...records.values()].flatMap((record) =>
		record.provider.groups.flatMap((group) =>
			group.fields.flatMap((field) => {
				if (!query) return [{ providerId: record.provider.id, groupId: group.id, field }];
				const searchable =
					`${record.provider.title} ${group.title} ${field.label} ${field.description}`.toLocaleLowerCase();
				return searchable.includes(query)
					? [{ providerId: record.provider.id, groupId: group.id, field }]
					: [];
			}),
		),
	);
}

function updateValue(record: ProviderRecord, row: FieldRow, value: HepiSettingValue): void {
	record.current = {
		...record.current,
		[row.groupId]: { ...(record.current[row.groupId] ?? {}), [row.field.id]: value },
	};
}

function cycleOption(field: HepiSettingField, value: HepiSettingValue): HepiSettingValue {
	const options = field.options;
	if (!options?.length) throw new Error(`Setting has no options: ${field.id}`);
	const index = options.findIndex((option) => Object.is(option.value, value));
	return options[(index + 1 + options.length) % options.length]?.value ?? field.defaultValue;
}

function wrapDescription(description: string, width: number): readonly string[] {
	const lines: string[] = [];
	for (const word of description.split(/\s+/u)) {
		const previous = lines.at(-1);
		if (previous === undefined || previous.length + word.length + 1 > width) lines.push(word);
		else lines[lines.length - 1] = `${previous} ${word}`;
	}
	return lines;
}

function detailLines(
	row: FieldRow | undefined,
	record: ProviderRecord | undefined,
	width: number,
	theme: Theme,
): string[] {
	if (row === undefined || record === undefined)
		return [theme.fg("muted", "No extension settings are registered.")];
	const value = String(valueFor(row, record));
	return [
		theme.bold(truncateToWidth(row.field.label, width)),
		"",
		...wrapDescription(row.field.description, width),
		"",
		theme.fg("muted", `Provider: ${record.provider.title}`),
		theme.fg("muted", `Value: ${value}`),
	];
}

/** Renders generic registered provider fields; provider persistence and live policy remain provider-owned. */
export async function createSettingsPage(
	registry: HepiSettingsRegistry,
	context: ExtensionPageViewContext,
): Promise<ExtensionPageView> {
	const hepiContext: HepiContext = {
		sessionId: "settings",
		cwd: context.command.cwd,
		signal: context.signal,
	};
	const records = new Map<string, ProviderRecord>();
	for (const provider of registry.list()) {
		const state = mergeDefaults(provider, await provider.storage.load(hepiContext));
		context.signal.throwIfAborted();
		records.set(provider.id, { provider, initial: cloneState(state), current: state });
		await provider.onLoad?.(cloneState(state), hepiContext);
	}
	let search = "";
	let selected = 0;
	let editor: Input | undefined;
	let editing: FieldRow | undefined;
	let error: string | undefined;
	let closing = false;

	const rows = (): readonly FieldRow[] => fieldRows(records, search);
	const selectedRow = (): FieldRow | undefined => rows()[selected];
	const selectedRecord = (): ProviderRecord | undefined => {
		const row = selectedRow();
		return row === undefined ? undefined : records.get(row.providerId);
	};
	const select = (offset: number): void => {
		const items = rows();
		if (items.length === 0) return;
		selected = Math.max(0, Math.min(items.length - 1, selected + offset));
	};
	const save = async (): Promise<void> => {
		for (const record of records.values()) {
			if (!isDirty(record)) continue;
			await record.provider.storage.validate?.(cloneState(record.current), hepiContext);
			for (const group of record.provider.groups)
				for (const field of group.fields) {
					const previousValue = record.initial[group.id]?.[field.id];
					const value = record.current[group.id]?.[field.id];
					if (Object.is(previousValue, value)) continue;
					await record.provider.onChange?.(
						{
							groupId: group.id,
							fieldId: field.id,
							value: value ?? field.defaultValue,
							...(previousValue === undefined ? {} : { previousValue }),
							state: cloneState(record.current),
						},
						hepiContext,
					);
				}
			await record.provider.storage.save(cloneState(record.current), hepiContext);
			record.initial = cloneState(record.current);
		}
	};
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		try {
			await save();
			await Promise.all(
				[...records.values()].map(async (record) => {
					await record.provider.onClose?.(cloneState(record.current), hepiContext);
					await record.provider.storage.close?.(hepiContext);
				}),
			);
			context.requestClose();
		} catch (cause: unknown) {
			closing = false;
			error = readableError(cause);
			context.requestRender();
		}
	};
	const startEdit = (): void => {
		const row = selectedRow();
		const record = selectedRecord();
		if (row === undefined || record === undefined) return;
		if (row.field.type === "boolean") {
			updateValue(record, row, !valueFor(row, record));
			context.requestRender();
			return;
		}
		if (row.field.type === "enum") {
			updateValue(record, row, cycleOption(row.field, valueFor(row, record)));
			context.requestRender();
			return;
		}
		editing = row;
		editor = new Input();
		editor.setValue(String(valueFor(row, record) ?? ""));
		editor.handleInput("\x1b[F");
		context.requestRender();
	};
	const commitEdit = (): void => {
		const row = editing;
		const record = row === undefined ? undefined : records.get(row.providerId);
		if (row === undefined || record === undefined || editor === undefined) return;
		try {
			const value = row.field.parse(editor.getValue());
			const validation = row.field.validate?.(value);
			if (validation !== undefined) throw new Error(validation);
			updateValue(record, row, value);
			editor = undefined;
			editing = undefined;
			error = undefined;
		} catch (cause: unknown) {
			error = readableError(cause);
		}
		context.requestRender();
	};

	const component = {
		render(width: number): string[] {
			const items = rows();
			if (selected >= items.length) selected = Math.max(0, items.length - 1);
			const row = selectedRow();
			const record = selectedRecord();
			const leftWidth = width >= 72 ? Math.max(28, Math.floor(width * 0.55)) : width;
			const rightWidth = Math.max(0, width - leftWidth - 3);
			const list = [
				`> ${search || "_"}`,
				...items.map((item, index) => {
					const itemRecord = records.get(item.providerId);
					const value = itemRecord === undefined ? "" : String(valueFor(item, itemRecord));
					const prefix = index === selected ? context.theme.fg("accent", "→ ") : "  ";
					const label = `${item.field.label}  ${value}`;
					return truncateToWidth(`${prefix}${label}`, leftWidth);
				}),
				context.theme.fg("dim", "↕ navigate · ␣ change · ⎋ close"),
			];
			if (editing !== undefined && editor !== undefined)
				list.push(context.theme.fg("accent", `> ${editor.getValue()}`));
			if (error !== undefined) list.push(context.theme.fg("error", `Error: ${error}`));
			if (rightWidth === 0) return list.map((line) => truncateToWidth(line, width));
			const detail = detailLines(row, record, rightWidth, context.theme);
			const lineCount = Math.max(list.length, detail.length);
			return Array.from({ length: lineCount }, (_, index) => {
				const left = truncateToWidth(list[index] ?? "", leftWidth);
				return `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(left)))}   ${truncateToWidth(detail[index] ?? "", rightWidth)}`;
			});
		},
		handleInput(input: string): void {
			if (editing !== undefined && editor !== undefined) {
				if (matchesKey(input, Key.escape)) {
					editing = undefined;
					editor = undefined;
					context.requestRender();
					return;
				}
				if (matchesKey(input, Key.enter)) {
					commitEdit();
					return;
				}
				editor.handleInput(input);
				context.requestRender();
				return;
			}
			if (matchesKey(input, Key.up)) select(-1);
			else if (matchesKey(input, Key.down)) select(1);
			else if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) startEdit();
			else if (matchesKey(input, Key.backspace)) search = search.slice(0, -1);
			else if (matchesKey(input, Key.escape)) {
				if (search) search = "";
				else void close();
			} else if (isPrintable(input)) search += input;
			context.requestRender();
		},
		invalidate(): void {
			context.requestRender();
		},
	};
	return {
		component,
		handleInput(input: string): boolean {
			if (editing === undefined && (matchesKey(input, Key.left) || matchesKey(input, Key.right)))
				return false;
			component.handleInput(input);
			return true;
		},
		close,
	};
}
