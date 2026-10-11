import type {
	SettingField,
	SettingsContext,
	SettingsProvider,
	SettingsState,
	SettingValue,
} from "@hheei/pi-ext-core";

export interface FieldRow {
	readonly groupId: string;
	readonly field: SettingField;
}

export function cloneState(state: SettingsState): SettingsState {
	return JSON.parse(JSON.stringify(state)) as SettingsState;
}

export function isValidStoredValue(field: SettingField, value: unknown): value is SettingValue {
	if (value === null) return false;
	switch (field.type) {
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "enum":
			return (
				typeof value === "string" &&
				(field.options?.some((option) => option.value === value) ?? false)
			);
		case "text":
		case "path":
			return typeof value === "string";
		case "list":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
	}
}

export function mergeDefaults(
	provider: SettingsProvider,
	stored: SettingsState | undefined,
): SettingsState {
	const result: SettingsState = {};
	for (const group of provider.groups) {
		const groupState: Record<string, SettingValue> = {};
		for (const field of group.fields) {
			const candidate = stored?.[group.id]?.[field.id];
			groupState[field.id] = isValidStoredValue(field, candidate) ? candidate : field.defaultValue;
			if (field.tabCycle !== undefined) {
				const related = field.tabCycle;
				const relatedCandidate = stored?.[group.id]?.[related.fieldId];
				const relatedField: SettingField = {
					...field,
					id: related.fieldId,
					label: related.label,
					type: "enum",
					defaultValue: related.defaultValue,
					description: related.description,
					parse: (v) => v,
					options: related.options,
				};
				groupState[related.fieldId] = isValidStoredValue(relatedField, relatedCandidate)
					? relatedCandidate
					: related.defaultValue;
			}
		}
		result[group.id] = groupState;
	}
	return result;
}

export function cycleOption(field: SettingField, value: SettingValue, direction = 1): SettingValue {
	if (field.type === "boolean") return !value;
	if (field.type !== "enum" || field.options === undefined || field.options.length === 0)
		return value;
	const index = field.options.findIndex((option) => Object.is(option.value, value));
	if (index === -1) return field.options[0]?.value ?? field.defaultValue;
	const total = field.options.length;
	const next = (index + direction + total) % total;
	return field.options[next]?.value ?? field.defaultValue;
}

export function allChangedFields(
	provider: SettingsProvider,
	before: SettingsState,
	after: SettingsState,
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

export interface SettingsDraftSession {
	readonly provider: SettingsProvider;
	readonly context: SettingsContext;
	get(groupId: string, fieldId: string): SettingValue | undefined;
	set(groupId: string, fieldId: string, value: SettingValue): void;
	cycle(groupId: string, fieldId: string, direction?: number): SettingValue | undefined;
	getRelated(groupId: string, fieldId: string): SettingValue | undefined;
	cycleRelated(groupId: string, fieldId: string, direction?: number): SettingValue | undefined;
	formattedValue(row: FieldRow, surface: "display" | "description"): string;
	isModified(): boolean;
	validate(): Promise<string | undefined>;
	commit(): Promise<void>;
	rollback(): void;
	close(): Promise<void>;
	getDraftState(): SettingsState;
	getCommittedState(): SettingsState;
}

export async function createSettingsDraftSession(
	provider: SettingsProvider,
	context: SettingsContext,
): Promise<SettingsDraftSession> {
	const initial = mergeDefaults(provider, await provider.storage.load(context));
	context.signal?.throwIfAborted();
	await provider.onLoad?.(cloneState(initial), context);
	context.signal?.throwIfAborted();

	let committed = cloneState(initial);
	let draft = cloneState(initial);
	let closed = false;

	const session: SettingsDraftSession = {
		provider,
		context,
		get(groupId: string, fieldId: string): SettingValue | undefined {
			return draft[groupId]?.[fieldId];
		},
		set(groupId: string, fieldId: string, value: SettingValue): void {
			const group = draft[groupId] ?? {};
			draft = { ...draft, [groupId]: { ...group, [fieldId]: value } };
		},
		cycle(groupId: string, fieldId: string, direction = 1): SettingValue | undefined {
			const group = provider.groups.find((g) => g.id === groupId);
			const field = group?.fields.find((f) => f.id === fieldId);
			if (field === undefined) return undefined;
			const current = draft[groupId]?.[fieldId] ?? field.defaultValue;
			const next = cycleOption(field, current, direction);
			session.set(groupId, fieldId, next);
			return next;
		},
		getRelated(groupId: string, fieldId: string): SettingValue | undefined {
			const group = provider.groups.find((g) => g.id === groupId);
			const field = group?.fields.find((f) => f.id === fieldId);
			const related = field?.tabCycle;
			if (related === undefined) return undefined;
			return draft[groupId]?.[related.fieldId] ?? related.defaultValue;
		},
		cycleRelated(groupId: string, fieldId: string, direction = 1): SettingValue | undefined {
			const group = provider.groups.find((g) => g.id === groupId);
			const field = group?.fields.find((f) => f.id === fieldId);
			const related = field?.tabCycle;
			if (related === undefined) return undefined;
			const relatedField: SettingField = {
				...field,
				id: related.fieldId,
				label: related.label,
				type: "enum",
				defaultValue: related.defaultValue,
				description: related.description,
				parse: (v) => v,
				options: related.options,
			};
			const current = draft[groupId]?.[related.fieldId] ?? related.defaultValue;
			const next = cycleOption(relatedField, current, direction);
			session.set(groupId, related.fieldId, next);
			return next;
		},
		formattedValue(row: FieldRow, surface: "display" | "description"): string {
			const value = draft[row.groupId]?.[row.field.id] ?? row.field.defaultValue;
			const related = row.field.tabCycle;
			const relatedValue =
				related === undefined
					? undefined
					: (draft[row.groupId]?.[related.fieldId] ?? related.defaultValue);
			const formatter =
				surface === "display" ? row.field.formatDisplay : row.field.formatDescription;
			if (formatter !== undefined) return formatter(value as never, relatedValue as never);
			const base =
				row.field.format?.(value as never) ??
				(value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value));
			if (related === undefined) return base;
			const label = related.options.find((option) => Object.is(option.value, relatedValue))?.label;
			return `${base}${related.separator ?? " · "}${label ?? String(relatedValue)}`;
		},
		isModified(): boolean {
			return JSON.stringify(draft) !== JSON.stringify(committed);
		},
		async validate(): Promise<string | undefined> {
			try {
				for (const group of provider.groups) {
					for (const field of group.fields) {
						const value = draft[group.id]?.[field.id] ?? field.defaultValue;
						const validation = field.validate?.(value as never);
						if (validation !== undefined) return validation;
					}
				}
				await provider.storage.validate?.(cloneState(draft), context);
				return undefined;
			} catch (cause: unknown) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		async commit(): Promise<void> {
			if (!session.isModified()) return;
			const validation = await session.validate();
			if (validation !== undefined) throw new Error(validation);

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
					context,
				);
			}
			await provider.storage.save(cloneState(draft), context);
			committed = cloneState(draft);
		},
		rollback(): void {
			draft = cloneState(committed);
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const failures: unknown[] = [];
			try {
				await provider.onClose?.(cloneState(draft), context);
			} catch (cause: unknown) {
				failures.push(cause);
			}
			try {
				await provider.storage.close?.(context);
			} catch (cause: unknown) {
				failures.push(cause);
			}
			if (failures.length > 0) throw new AggregateError(failures, "Settings cleanup failed");
		},
		getDraftState(): SettingsState {
			return cloneState(draft);
		},
		getCommittedState(): SettingsState {
			return cloneState(committed);
		},
	};

	return session;
}
