/**
 * Task result schemas.
 *
 * A task child may be asked for a structured result. The schema is caller-supplied JSON
 * Schema, and TypeBox silently ignores what it does not understand: an unknown `type`
 * name matches every value, `minLength: "x"` is skipped, and `format: "zzz"` validates
 * nothing. Accepting such a schema would report success for a result that was never
 * actually checked, so the schema is shape-checked against an explicit allowlist before
 * it is used, and anything outside that support surface is rejected instead of ignored.
 */
import { isRecord } from "@hheei/pi-ext-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Schema size bound; validation must stay a local, cheap operation. */
export const MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024;
/** Node and depth bounds keep one pathological schema from dominating a validation. */
export const MAX_OUTPUT_SCHEMA_NODES = 512;
export const MAX_OUTPUT_SCHEMA_DEPTH = 24;
/** Structured results stay well below the registry's text truncation point. */
export const MAX_TASK_RESULT_BYTES = 32 * 1024;

const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

/**
 * The bounds below are stated in bytes, and a JSON string's length is UTF-16 code units: a result
 * full of non-ASCII text would otherwise pass the check while occupying more than the limit allows.
 */
function byteSize(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Format names TypeBox actually enforces. */
const SUPPORTED_FORMATS = new Set([
	"date-time",
	"date",
	"time",
	"duration",
	"email",
	"hostname",
	"ipv4",
	"ipv6",
	"uri",
	"uri-reference",
	"uuid",
	"regex",
	"json-pointer",
	"relative-json-pointer",
]);

/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS = ["not", "if", "then", "else"];
/** Keywords whose value is one subschema and that descend into the instance. */
const DATA_SUBSCHEMA_KEYWORDS = ["additionalProperties", "propertyNames", "contains"];
/** Keywords whose value maps names to subschemas, descending into the instance. */
const DATA_SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties"];
/** Keywords whose value is a list of subschemas that do not descend into the instance. */
const SUBSCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf"];

/** Keywords that affect validation but are not enforced by the current validator. */
const UNSUPPORTED_KEYWORDS: Record<string, string> = {
	$id: "changing ref resolution is not supported",
	$anchor: "changing ref resolution is not supported",
	$dynamicRef: "dynamic refs are not supported",
	$dynamicAnchor: "dynamic refs are not supported",
	$recursiveRef: "recursive refs are not supported",
	$recursiveAnchor: "recursive refs are not supported",
	$vocabulary: "vocabularies are not supported",
	unevaluatedProperties: "unevaluated properties are not supported",
	unevaluatedItems: "unevaluated items are not supported",
	dependentSchemas: "dependent schemas are not supported",
	contentEncoding: "content encodings are not supported",
	contentMediaType: "content media types are not supported",
	contentSchema: "content schemas are not supported",
};

const SUPPORTED_KEYWORDS = new Set([
	"$schema",
	"$comment",
	"$ref",
	"$defs",
	"definitions",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"type",
	"enum",
	"const",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"propertyNames",
	"minProperties",
	"maxProperties",
	"dependentRequired",
	"items",
	"prefixItems",
	"contains",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains",
	"uniqueItems",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
]);

const BOOLEAN_KEYWORDS = ["uniqueItems", "deprecated", "readOnly", "writeOnly"];
const NUMBER_KEYWORDS = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
];
const COUNT_KEYWORDS = [
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
];

interface WalkState {
	/** The schema root. Refs resolve against it, not against the node that declares them. */
	readonly root: Record<string, unknown>;
	nodes: number;
	/**
	 * How far the walk had descended into the instance when each ref on the current path was
	 * entered. A ref that is re-entered at the same depth cannot terminate and would make the
	 * validator recurse forever; a ref re-entered deeper is ordinary recursion over a value.
	 */
	readonly walking: Map<string, number>;
	readonly checked: Set<string>;
	dataDepth: number;
}

function isSchemaNode(node: unknown): node is Record<string, unknown> {
	return typeof node === "boolean" || isRecord(node);
}

/** True when the validator can compile this regular expression. */
function isUsablePattern(value: string): boolean {
	try {
		new RegExp(value, "u");
		return true;
	} catch {
		return false;
	}
}

const SCALAR_KEYWORDS = new Set([
	...BOOLEAN_KEYWORDS,
	...NUMBER_KEYWORDS,
	...COUNT_KEYWORDS,
	"type",
	"format",
	"pattern",
	"required",
	"dependentRequired",
	"enum",
]);
const STRUCTURAL_KEYWORDS = new Set([
	...SUBSCHEMA_KEYWORDS,
	...DATA_SUBSCHEMA_KEYWORDS,
	...SUBSCHEMA_LIST_KEYWORDS,
	...DATA_SCHEMA_MAP_KEYWORDS,
	"items",
	"prefixItems",
	"$defs",
	"definitions",
]);

/** Checks keywords whose value is data rather than another schema. */
function checkScalarKeyword(keyword: string, value: unknown, path: string): string | undefined {
	if (BOOLEAN_KEYWORDS.includes(keyword)) {
		return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
	}
	if (NUMBER_KEYWORDS.includes(keyword)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return `${path} must be a finite number`;
		}
		// A zero or negative divisor never validates anything, so accepting it would let a schema
		// look enforceable while it is not.
		if (keyword === "multipleOf" && value <= 0) return `${path} must be greater than 0`;
		return undefined;
	}
	if (COUNT_KEYWORDS.includes(keyword)) {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			? undefined
			: `${path} must be a non-negative integer`;
	}
	if (keyword === "type") {
		const names = Array.isArray(value) ? value : [value];
		if (names.length === 0) return `${path} must name at least one JSON type`;
		for (const name of names) {
			if (typeof name !== "string" || !JSON_TYPES.has(name)) {
				return `${path} names an unknown JSON type ${JSON.stringify(name)}`;
			}
		}
		return undefined;
	}
	if (keyword === "format") {
		return typeof value === "string" && SUPPORTED_FORMATS.has(value)
			? undefined
			: `${path} uses an unsupported format ${JSON.stringify(value)}`;
	}
	if (keyword === "pattern") {
		if (typeof value !== "string") return `${path} must be a string`;
		return isUsablePattern(value) ? undefined : `${path} must be a valid regular expression`;
	}
	if (keyword === "required") {
		return Array.isArray(value) && value.every((entry) => typeof entry === "string")
			? undefined
			: `${path} must be an array of property names`;
	}
	if (keyword === "dependentRequired") {
		const wellFormed =
			isRecord(value) &&
			Object.values(value).every(
				(entry) => Array.isArray(entry) && entry.every((name) => typeof name === "string"),
			);
		return wellFormed ? undefined : `${path} must map property names to arrays of property names`;
	}
	if (keyword === "enum") {
		return Array.isArray(value) && value.length > 0
			? undefined
			: `${path} must be a non-empty array`;
	}
	return undefined;
}

/** Checks keywords whose value is one or more subschemas. */
function checkStructuralKeyword(
	keyword: string,
	value: unknown,
	path: string,
	child: (value: unknown, path: string, descendsIntoData?: boolean) => string | undefined,
): string | undefined {
	if (keyword === "items") {
		if (Array.isArray(value)) return `${path} must be one schema; use prefixItems for a tuple`;
		return child(value, path, true);
	}
	if (keyword === "prefixItems") {
		if (!Array.isArray(value)) return `${path} must be an array of schemas`;
		for (const [index, entry] of value.entries()) {
			const result = child(entry, `${path}/${index}`, true);
			if (result !== undefined) return result;
		}
		return undefined;
	}
	if (SUBSCHEMA_LIST_KEYWORDS.includes(keyword)) {
		if (!Array.isArray(value)) return `${path} must be an array of schemas`;
		for (const [index, entry] of value.entries()) {
			const result = child(entry, `${path}/${index}`);
			if (result !== undefined) return result;
		}
		return undefined;
	}
	if (keyword === "$defs" || keyword === "definitions") {
		if (!isRecord(value)) return `${path} must be an object of schemas`;
		for (const [name, entry] of Object.entries(value)) {
			const result = child(entry, `${path}/${name}`);
			if (result !== undefined) return result;
		}
		return undefined;
	}
	if (DATA_SCHEMA_MAP_KEYWORDS.includes(keyword)) {
		if (!isRecord(value)) return `${path} must be an object of schemas`;
		for (const [name, entry] of Object.entries(value)) {
			// `patternProperties` matches with a regex, so an unusable key would turn the whole
			// schema into a validation failure the caller cannot see.
			if (keyword === "patternProperties" && !isUsablePattern(name)) {
				return `${path}/${name} is not a usable regular expression`;
			}
			const result = child(entry, `${path}/${name}`, true);
			if (result !== undefined) return result;
		}
		return undefined;
	}
	if (!isSchemaNode(value)) return `${path} must be a schema`;
	return child(value, path, DATA_SUBSCHEMA_KEYWORDS.includes(keyword));
}

/**
 * Walks one schema node. Every node sees the data depth of its own level, so understanding a
 * terminating recursion is a matter of counting instance steps, not of remembering how the node
 * was reached.
 */
function checkNode(
	node: unknown,
	path: string,
	depth: number,
	state: WalkState,
): string | undefined {
	if (depth > MAX_OUTPUT_SCHEMA_DEPTH) return `${path} nests too deeply`;
	state.nodes += 1;
	if (state.nodes > MAX_OUTPUT_SCHEMA_NODES) return `${path} has too many nodes`;
	if (typeof node === "boolean") return undefined;
	if (!isRecord(node)) return `${path} must be a schema object`;
	const child = (
		value: unknown,
		childPath: string,
		descendsIntoData = false,
	): string | undefined => {
		const saved = state.dataDepth;
		// Reading a property or an item moves one level into the instance, whichever node asked.
		if (descendsIntoData) state.dataDepth = saved + 1;
		const result = checkNode(value, childPath, depth + 1, state);
		state.dataDepth = saved;
		return result;
	};

	for (const [keyword, value] of Object.entries(node)) {
		const keywordPath = `${path}/${keyword}`;
		const unsupported = UNSUPPORTED_KEYWORDS[keyword];
		if (unsupported !== undefined) return `${keywordPath} is not supported (${unsupported})`;
		if (!SUPPORTED_KEYWORDS.has(keyword)) return `${keywordPath} is not a supported keyword`;
		if (keyword === "$ref") {
			const result = checkRef(value, keywordPath, depth, state);
			if (result !== undefined) return result;
			continue;
		}
		if (SCALAR_KEYWORDS.has(keyword)) {
			const result = checkScalarKeyword(keyword, value, keywordPath);
			if (result !== undefined) return result;
			continue;
		}
		if (STRUCTURAL_KEYWORDS.has(keyword)) {
			const result = checkStructuralKeyword(keyword, value, keywordPath, child);
			if (result !== undefined) return result;
		}
	}
	return undefined;
}

/** Resolves and walks one ref, rejecting a cycle that never moves into the instance. */
function checkRef(
	value: unknown,
	path: string,
	depth: number,
	state: WalkState,
): string | undefined {
	if (typeof value !== "string") return `${path} must be a string`;
	const target = resolveLocalRef(state.root, value);
	if (target === undefined) {
		return `${path} must point at #/$defs or #/definitions inside this schema, not ${value}`;
	}
	if (state.checked.has(value)) return undefined;
	const enteredAt = state.walking.get(value);
	if (enteredAt !== undefined) {
		if (enteredAt === state.dataDepth) {
			return `${path} revisits ${value} without reading a property or item, so validation would not terminate`;
		}
		return undefined;
	}
	state.walking.set(value, state.dataDepth);
	const result = checkNode(target, value, depth + 1, state);
	state.walking.delete(value);
	state.checked.add(value);
	return result;
}

/**
 * Resolves a fragment-only ref against the root. External targets are refused: the validator
 * reports a failure for them, and an unreadable schema must not look like a rejected result.
 */
function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
	if (!ref.startsWith("#/")) return undefined;
	const [head, ...rest] = ref.slice(2).split("/");
	if (head !== "$defs" && head !== "definitions") return undefined;
	let current: unknown = root;
	for (const rawSegment of [head, ...rest]) {
		const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
		current = current[segment];
	}
	return current;
}

/** Returns a reason when the caller-supplied schema cannot be validated faithfully. */
export function checkOutputSchema(schema: unknown): string | undefined {
	if (!isRecord(schema)) return "outputSchema must be a JSON object";
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(schema);
	} catch {
		return "outputSchema is not serializable";
	}
	if (serialized === undefined) return "outputSchema is not serializable";
	if (byteSize(serialized) > MAX_OUTPUT_SCHEMA_BYTES) {
		return `outputSchema is larger than ${MAX_OUTPUT_SCHEMA_BYTES} bytes`;
	}
	return checkNode(schema, "#", 0, {
		root: schema,
		nodes: 0,
		walking: new Map(),
		checked: new Set(),
		dataDepth: 0,
	});
}

/** Returns a human-readable reason when the value does not satisfy the schema. */
export function describeResultErrors(schema: unknown, value: unknown): string | undefined {
	const errors = [...Value.Errors(schema as TSchema, value)];
	if (errors.length === 0) return undefined;
	return errors
		.slice(0, 5)
		.map((error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message}`)
		.join("; ");
}

export interface TaskResultCandidate {
	readonly json: string;
	readonly value: unknown;
}

/**
 * Validates a structured candidate and returns the JSON delivered to the parent. An oversized
 * candidate is refused instead of truncated, because truncated JSON is no longer the value the
 * schema accepted.
 */
export function prepareStructuredResult(
	schema: unknown,
	value: unknown,
):
	| { readonly ok: true; readonly candidate: TaskResultCandidate }
	| { readonly ok: false; readonly reason: string } {
	const mismatch = describeResultErrors(schema, value);
	if (mismatch !== undefined) {
		return { ok: false, reason: `Result does not match outputSchema: ${mismatch}` };
	}
	const json = JSON.stringify(value);
	if (json === undefined) return { ok: false, reason: "Result is not serializable as JSON" };
	const jsonBytes = byteSize(json);
	if (jsonBytes > MAX_TASK_RESULT_BYTES) {
		return {
			ok: false,
			reason: `Result is ${jsonBytes} bytes and exceeds the ${MAX_TASK_RESULT_BYTES} byte limit; return a smaller value`,
		};
	}
	return { ok: true, candidate: { json, value } };
}

/** Bounds a text result the same way, so a schema-less task cannot flood the parent. */
export function prepareTextResult(
	text: string,
):
	| { readonly ok: true; readonly candidate: TaskResultCandidate }
	| { readonly ok: false; readonly reason: string } {
	const textBytes = byteSize(text);
	if (textBytes > MAX_TASK_RESULT_BYTES) {
		return {
			ok: false,
			reason: `Result is ${textBytes} bytes and exceeds the ${MAX_TASK_RESULT_BYTES} byte limit; summarize it`,
		};
	}
	return { ok: true, candidate: { json: text, value: text } };
}
