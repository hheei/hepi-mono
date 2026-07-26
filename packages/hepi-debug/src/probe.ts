import { createHash } from "node:crypto";

interface JsonObject {
	readonly [key: string]: unknown;
}

export interface ValueDigest {
	readonly hash: string;
	readonly bytes: number;
}

export interface ItemDigest extends ValueDigest {
	readonly kind: string;
}

export interface ModuleDigest extends ValueDigest {
	readonly name: string;
	readonly itemCount: number;
	readonly startIndex: number | null;
	readonly endIndex: number | null;
	readonly prefixHash: string | null;
}

export interface PayloadSnapshot {
	readonly payload: ValueDigest;
	readonly envelope: ValueDigest;
	readonly inputKey: "input" | "messages" | "contents" | null;
	readonly input: ValueDigest;
	readonly items: readonly ItemDigest[];
	readonly modules: readonly ModuleDigest[];
}

export interface FirstChangedItem {
	readonly index: number;
	readonly previous: ItemDigest | null;
	readonly current: ItemDigest | null;
}

export interface PayloadComparison {
	readonly previousItems: number;
	readonly commonPrefixItems: number;
	readonly appendOnly: boolean | null;
	readonly firstChangedItem: FirstChangedItem | null;
	readonly changedModules: readonly string[];
}

const CONTENT_KEYS = new Set([
	"input",
	"messages",
	"contents",
	"tools",
	"functions",
	"system",
	"instructions",
]);

const M0_MARKERS = ["<project-memory>", "<user-memory>", "<project-context>", "<user-profile>"];

export function snapshotProviderPayload(payload: unknown): PayloadSnapshot {
	const object = isJsonObject(payload) ? payload : {};
	const inputEntry = findInput(object);
	const items = inputEntry.items.map((item) => ({
		...digest(item),
		kind: itemKind(item),
	}));
	const classified = inputEntry.items.map(classifyInputItem);
	const modules: ModuleDigest[] = [];

	const envelope = Object.fromEntries(
		Object.entries(object).filter(([key]) => !CONTENT_KEYS.has(key)),
	);
	modules.push(moduleDigest("envelope", envelope, [], inputEntry.items));

	const tools = pickPresent(object, ["tools", "functions"]);
	if (Object.keys(tools).length > 0) {
		modules.push(moduleDigest("tools", tools, [], inputEntry.items));
	}

	const topLevelSystem = pickPresent(object, ["system", "instructions"]);
	const systemIndices = indicesOf(classified, "system");
	if (Object.keys(topLevelSystem).length > 0 || systemIndices.length > 0) {
		modules.push(
			moduleDigest(
				"system",
				{
					topLevel: topLevelSystem,
					items: systemIndices.map((index) => inputEntry.items[index]),
				},
				systemIndices,
				inputEntry.items,
			),
		);
	}

	for (const name of ["magic-context:m0", "magic-context:m1", "conversation"] as const) {
		const indices = indicesOf(classified, name);
		if (indices.length === 0) continue;
		modules.push(
			moduleDigest(
				name,
				indices.map((index) => inputEntry.items[index]),
				indices,
				inputEntry.items,
			),
		);
	}

	return {
		payload: digest(payload),
		envelope: digest(envelope),
		inputKey: inputEntry.key,
		input: digest(inputEntry.items),
		items,
		modules,
	};
}

export function comparePayloadSnapshots(
	previous: PayloadSnapshot | undefined,
	current: PayloadSnapshot,
): PayloadComparison {
	if (previous === undefined) {
		return {
			previousItems: 0,
			commonPrefixItems: 0,
			appendOnly: null,
			firstChangedItem: null,
			changedModules: [],
		};
	}

	const limit = Math.min(previous.items.length, current.items.length);
	let commonPrefixItems = 0;
	while (
		commonPrefixItems < limit &&
		previous.items[commonPrefixItems]?.hash === current.items[commonPrefixItems]?.hash
	) {
		commonPrefixItems += 1;
	}
	const appendOnly = commonPrefixItems === previous.items.length;
	const changedModules = current.modules
		.filter(
			(module) =>
				previous.modules.find((prior) => prior.name === module.name)?.hash !== module.hash,
		)
		.map((module) => module.name);
	for (const prior of previous.modules) {
		if (!current.modules.some((module) => module.name === prior.name))
			changedModules.push(prior.name);
	}

	const hasChangedItem =
		commonPrefixItems < previous.items.length || commonPrefixItems < current.items.length;
	return {
		previousItems: previous.items.length,
		commonPrefixItems,
		appendOnly,
		firstChangedItem: hasChangedItem
			? {
					index: commonPrefixItems,
					previous: previous.items[commonPrefixItems] ?? null,
					current: current.items[commonPrefixItems] ?? null,
				}
			: null,
		changedModules,
	};
}

export function requestLogSnapshot(snapshot: PayloadSnapshot): Omit<PayloadSnapshot, "items"> & {
	readonly itemCount: number;
} {
	return {
		payload: snapshot.payload,
		envelope: snapshot.envelope,
		inputKey: snapshot.inputKey,
		input: snapshot.input,
		itemCount: snapshot.items.length,
		modules: snapshot.modules,
	};
}

function findInput(object: JsonObject): {
	readonly key: "input" | "messages" | "contents" | null;
	readonly items: readonly unknown[];
} {
	for (const key of ["input", "messages", "contents"] as const) {
		if (Array.isArray(object[key])) return { key, items: object[key] };
	}
	return { key: null, items: [] };
}

function classifyInputItem(item: unknown): string {
	if (isJsonObject(item) && (item.role === "system" || item.role === "developer")) return "system";
	const serialized = serialize(item);
	if (serialized.includes("<session-history")) return "magic-context:m1";
	if (M0_MARKERS.some((marker) => serialized.includes(marker))) return "magic-context:m0";
	return "conversation";
}

function itemKind(item: unknown): string {
	if (!isJsonObject(item)) return Array.isArray(item) ? "array" : typeof item;
	if (typeof item.type === "string") return item.type;
	if (typeof item.role === "string") return `role:${item.role}`;
	return "object";
}

function indicesOf(values: readonly string[], expected: string): number[] {
	const indices: number[] = [];
	for (let index = 0; index < values.length; index += 1) {
		if (values[index] === expected) indices.push(index);
	}
	return indices;
}

function moduleDigest(
	name: string,
	value: unknown,
	indices: readonly number[],
	allItems: readonly unknown[],
): ModuleDigest {
	const valueDigest = digest(value);
	const startIndex = indices[0] ?? null;
	const endIndex = indices.at(-1) ?? null;
	return {
		name,
		...valueDigest,
		itemCount: indices.length,
		startIndex,
		endIndex,
		prefixHash: endIndex === null ? null : digest(allItems.slice(0, endIndex + 1)).hash,
	};
}

function pickPresent(object: JsonObject, keys: readonly string[]): JsonObject {
	return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

function digest(value: unknown): ValueDigest {
	const serialized = serialize(value);
	return {
		hash: createHash("sha256").update(serialized).digest("hex"),
		bytes: Buffer.byteLength(serialized, "utf8"),
	};
}

function serialize(value: unknown): string {
	return JSON.stringify(value) ?? "undefined";
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
