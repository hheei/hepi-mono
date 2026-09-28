import { describe, expect, test } from "vitest";
import {
	checkOutputSchema,
	describeResultErrors,
	MAX_OUTPUT_SCHEMA_BYTES,
	MAX_TASK_RESULT_BYTES,
	prepareStructuredResult,
	prepareTextResult,
} from "../src/task-schema.js";

const REPORT_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", minLength: 1, maxLength: 200 },
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					severity: { enum: ["low", "medium", "high"] },
				},
				required: ["path", "severity"],
				additionalProperties: false,
			},
		},
		generatedAt: { type: "string", format: "date-time" },
	},
	required: ["summary", "findings"],
	additionalProperties: false,
} as const;

describe("outputSchema shape check", () => {
	test("accepts a schema whose every keyword is enforced by the validator", () => {
		expect(checkOutputSchema(REPORT_SCHEMA)).toBeUndefined();
		expect(
			checkOutputSchema({
				type: "object",
				properties: { node: { $ref: "#/$defs/node" } },
				$defs: {
					node: {
						type: "object",
						properties: { name: { type: "string" }, child: { $ref: "#/$defs/node" } },
						required: ["name"],
					},
				},
			}),
		).toBeUndefined();
	});

	test("refuses a keyword the validator would ignore instead of enforce", () => {
		// `type: "wibble"` and `format: "zzz"` both pass every value in TypeBox, so a schema
		// using them must not be accepted as if the result had been checked.
		expect(checkOutputSchema({ type: "wibble" })).toContain("unknown JSON type");
		expect(checkOutputSchema({ type: "string", format: "zzz" })).toContain("unsupported format");
		expect(checkOutputSchema({ type: "string", minLength: "x" })).toContain("non-negative integer");
		expect(checkOutputSchema({ type: "object", unevaluatedProperties: false })).toContain(
			"not supported",
		);
		expect(checkOutputSchema({ type: "object", $id: "urn:x" })).toContain("not supported");
		expect(checkOutputSchema({ type: "object", wibble: 1 })).toContain("not a supported keyword");
	});

	test("refuses refs it cannot resolve inside the schema", () => {
		expect(checkOutputSchema({ $ref: "https://example.com/schema.json" })).toContain(
			"must point at #/$defs or #/definitions",
		);
		expect(checkOutputSchema({ $ref: "#/$defs/missing", $defs: {} })).toContain(
			"must point at #/$defs or #/definitions",
		);
	});

	test("accepts a root ref that recurses through a property", () => {
		// The ref is entered at the root and again one instance level down, which is a terminating
		// recursion rather than a cycle. Counting the descent per keyword is what tells them apart.
		expect(
			checkOutputSchema({
				$ref: "#/$defs/node",
				$defs: {
					node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } },
				},
			}),
		).toBeUndefined();
		expect(
			checkOutputSchema({
				type: "array",
				items: { $ref: "#/$defs/leaf" },
				$defs: { leaf: { type: "array", items: { $ref: "#/$defs/leaf" } } },
			}),
		).toBeUndefined();
	});

	test("refuses a ref cycle that never reads a property or item", () => {
		const cycle = checkOutputSchema({
			$defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
			$ref: "#/$defs/a",
		});
		expect(cycle).toContain("would not terminate");
	});

	test("refuses oversized and non-object schemas", () => {
		expect(checkOutputSchema("report")).toContain("must be a JSON object");
		const huge = { type: "object", description: "x".repeat(MAX_OUTPUT_SCHEMA_BYTES) };
		expect(checkOutputSchema(huge)).toContain("larger than");
		expect(checkOutputSchema({ type: "object", properties: { a: { pattern: "([" } } })).toContain(
			"valid regular expression",
		);
		// A pattern property matches with a regex, so an unusable key is as unusable as a pattern.
		expect(
			checkOutputSchema({ type: "object", patternProperties: { "([": { type: "string" } } }),
		).toContain("not a usable regular expression");
	});

	test("checks the keywords it claims to support", () => {
		// A tuple element is a schema like any other: letting it through unchecked would accept a
		// schema the validator cannot enforce.
		expect(checkOutputSchema({ type: "array", prefixItems: [{ type: "wibble" }] })).toContain(
			"unknown JSON type",
		);
		// A zero divisor never validates anything, so the schema would only look enforceable.
		expect(checkOutputSchema({ type: "number", multipleOf: 0 })).toContain("greater than 0");
		expect(checkOutputSchema({ type: "number", multipleOf: -2 })).toContain("greater than 0");
		expect(checkOutputSchema({ type: "array", prefixItems: [{ type: "string" }] })).toBeUndefined();
	});
});

describe("structured results", () => {
	test("validates against the schema and rejects a mismatch with readable errors", () => {
		const valid = prepareStructuredResult(REPORT_SCHEMA, {
			summary: "ok",
			findings: [{ path: "src/a.ts", severity: "high" }],
		});
		expect(valid.ok).toBe(true);
		expect(JSON.parse(valid.ok ? valid.candidate.json : "null")).toMatchObject({ summary: "ok" });

		const invalid = prepareStructuredResult(REPORT_SCHEMA, {
			summary: "ok",
			findings: [{ path: "src/a.ts", severity: "urgent" }],
		});
		expect(invalid.ok).toBe(false);
		expect(invalid.ok ? "" : invalid.reason).toContain("does not match outputSchema");
	});

	test("reports mismatches at the instance path that failed", () => {
		expect(describeResultErrors(REPORT_SCHEMA, { findings: [] })).toContain(
			"must have required properties summary",
		);
		const nested = describeResultErrors(REPORT_SCHEMA, {
			summary: "ok",
			findings: [{ path: 1, severity: "low" }],
		});
		expect(nested).toContain("/findings/0/path must be string");
	});

	test("refuses an oversized result instead of truncating it", () => {
		const schema = { type: "object", properties: { blob: { type: "string" } }, required: ["blob"] };
		const oversized = prepareStructuredResult(schema, { blob: "x".repeat(MAX_TASK_RESULT_BYTES) });
		expect(oversized.ok).toBe(false);
		expect(oversized.ok ? "" : oversized.reason).toContain("exceeds the");
		// Truncating would produce a value the schema never accepted.
		expect(oversized.ok).toBe(false);
	});

	test("bounds text results the same way", () => {
		expect(prepareTextResult("done")).toEqual({
			ok: true,
			candidate: { json: "done", value: "done" },
		});
		expect(prepareTextResult("x".repeat(MAX_TASK_RESULT_BYTES + 1))).toMatchObject({ ok: false });
	});
});

describe("declared limits and supported formats", () => {
	test("measures non-ASCII text in the unit it states", () => {
		// The bound is in bytes: three-byte characters would otherwise pass it at a third of their cost.
		const multibyte = "\u20ac".repeat(Math.floor(MAX_TASK_RESULT_BYTES / 3) + 1);
		const oversized = prepareTextResult(multibyte);
		expect(oversized.ok).toBe(false);
		expect(oversized.ok ? "" : oversized.reason).toContain(`${Buffer.byteLength(multibyte)} bytes`);
		expect(
			checkOutputSchema({ type: "string", description: "\u20ac".repeat(MAX_OUTPUT_SCHEMA_BYTES) }),
		).toContain("larger than");
	});

	test("only accepts formats the validator actually enforces", () => {
		// TypeBox enforces the formats it registers and silently passes an unknown one, so a schema
		// that names one is only usable because this list matches its registry: the accepted schema
		// is checked here, and the enforcement it promises is checked right after.
		const schema = { type: "string", format: "email" };
		expect(checkOutputSchema(schema)).toBeUndefined();
		expect(prepareStructuredResult(schema, "not-an-email")).toMatchObject({ ok: false });
		expect(prepareStructuredResult(schema, "someone@example.com")).toMatchObject({ ok: true });
		const uuid = { type: "string", format: "uuid" };
		expect(checkOutputSchema(uuid)).toBeUndefined();
		expect(prepareStructuredResult(uuid, "not-a-uuid")).toMatchObject({ ok: false });
		expect(prepareStructuredResult(uuid, "2c1f0a9e-6f6f-4a4c-9c1a-6f0a9e6f6f4a")).toMatchObject({
			ok: true,
		});
	});
});
