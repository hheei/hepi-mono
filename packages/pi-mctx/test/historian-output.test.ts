import { expect, test } from "bun:test";
import { mapMctxHistorianOutput } from "../src/historian-output.js";

const source = { entryIds: ["entry-1", "entry-2"], fingerprint: "snapshot-1" } as const;
const output = {
	tier: "m0",
	sourceStartEntryId: "entry-1",
	sourceEndEntryId: "entry-2",
	renderedPayload: "summary",
} as const;

test("maps exact historian JSON and injects the source fingerprint", (): void => {
	expect(mapMctxHistorianOutput(JSON.stringify(output), source)).toEqual({
		kind: "valid",
		value: {
			draft: { ...output, sourceFingerprint: "snapshot-1" },
			sourceStartIndex: 0,
			sourceEndIndex: 1,
		},
	});
});

test("rejects non-exact JSON output", (): void => {
	expect(mapMctxHistorianOutput("```json\n{}\n```", source)).toEqual({
		kind: "invalid",
		reason: "historian output must be exact JSON",
	});
	expect(mapMctxHistorianOutput('{"tier":"m0","extra":true}', source)).toEqual({
		kind: "invalid",
		reason: "historian output has an invalid compartment shape",
	});
});

test("returns source-validation diagnostics for repair", (): void => {
	expect(
		mapMctxHistorianOutput(JSON.stringify({ ...output, sourceStartEntryId: "missing" }), source),
	).toEqual({ kind: "invalid", reason: "source range is outside snapshot" });
});
