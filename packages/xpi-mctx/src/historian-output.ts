import {
	type MctxCompartmentSourceSnapshot,
	type ValidatedMctxCompartmentDraft,
	validateMctxCompartmentDraft,
} from "./compartment-validation.js";
import type { MctxCompartmentDraft } from "./store.js";

export type MctxHistorianOutputMapping =
	| { readonly kind: "valid"; readonly value: ValidatedMctxCompartmentDraft }
	| { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reason: string): MctxHistorianOutputMapping {
	return { kind: "invalid", reason };
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function parseDraft(value: unknown, sourceFingerprint: string): MctxCompartmentDraft | undefined {
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value).sort();
	const expected = ["renderedPayload", "sourceEndEntryId", "sourceStartEntryId", "tier"];
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		return undefined;
	}
	if (
		(value.tier !== "m0" && value.tier !== "m1") ||
		typeof value.sourceStartEntryId !== "string"
	) {
		return undefined;
	}
	if (typeof value.sourceEndEntryId !== "string" || typeof value.renderedPayload !== "string") {
		return undefined;
	}
	return {
		tier: value.tier,
		sourceStartEntryId: value.sourceStartEntryId,
		sourceEndEntryId: value.sourceEndEntryId,
		sourceFingerprint,
		renderedPayload: value.renderedPayload,
	};
}

/** Maps one untrusted historian response to a source-validated compartment draft. */
export function mapMctxHistorianOutput(
	text: string,
	source: MctxCompartmentSourceSnapshot,
): MctxHistorianOutputMapping {
	const parsed = parseJson(text);
	if (parsed === undefined) return invalid("historian output must be exact JSON");
	const draft = parseDraft(parsed, source.fingerprint);
	if (draft === undefined) return invalid("historian output has an invalid compartment shape");
	const validation = validateMctxCompartmentDraft(draft, source);
	return validation.kind === "valid"
		? { kind: "valid", value: validation.value }
		: invalid(validation.reason);
}
