import type { MctxHistoryTag } from "./store.js";

const LEVEL_BY_DEPTH = [undefined, "lite", "full", "ultra"] as const;
const PRESERVED = [
	/```[\s\S]*?```/gu,
	/`[^`\n]+`/gu,
	/https?:\/\/\S+/gu,
	/§\d+§/gu,
	/(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/gu,
	/(?<![a-z0-9])[0-9a-f]{7,40}(?![a-z0-9])/giu,
] as const;

const LITE_DROPS =
	/\b(?:just|really|basically|actually|essentially|simply|clearly|obviously|quite|very|somewhat|rather|fairly|please|thanks|thank you|kindly|i think|i believe|i feel|probably|perhaps|maybe|it seems|it appears|arguably|i suppose|i guess)\b\s*/giu;
const SHORTENINGS: readonly [RegExp, string][] = [
	[/\bin order to\b/giu, "to"],
	[/\bdue to the fact that\b/giu, "because"],
	[/\bat this point in time\b/giu, "now"],
	[/\bin the event that\b/giu, "if"],
];

export interface MctxCavemanDepthUpdate {
	readonly tagNumber: number;
	readonly depth: 1 | 2 | 3;
}

/** Execute-pass planner. Depth only increases; replay is a pure projection concern. */
export function planMctxCavemanDepths(
	tags: readonly MctxHistoryTag[],
	minChars: number,
	protectedTags: number,
): readonly MctxCavemanDepthUpdate[] {
	const protectedCutoff = Math.max(
		0,
		Math.max(0, ...tags.map((tag) => tag.tagNumber)) - protectedTags,
	);
	const eligible = tags
		.filter(
			(tag) =>
				tag.kind === "message" &&
				tag.status === "active" &&
				tag.tagNumber <= protectedCutoff &&
				tag.source.length >= minChars,
		)
		.sort((left, right) => left.tagNumber - right.tagNumber);
	return eligible.flatMap((tag, index): readonly MctxCavemanDepthUpdate[] => {
		const fraction = index / eligible.length;
		const depth: 0 | 1 | 2 | 3 = fraction < 0.2 ? 3 : fraction < 0.4 ? 2 : fraction < 0.6 ? 1 : 0;
		if (depth === 0) return [];
		return depth > (tag.cavemanDepth ?? 0) ? [{ tagNumber: tag.tagNumber, depth }] : [];
	});
}

function protect(text: string): { readonly text: string; readonly values: readonly string[] } {
	const values: string[] = [];
	let result = text;
	for (const pattern of PRESERVED) {
		result = result.replace(pattern, (value) => {
			values.push(value);
			return `\u0000${values.length - 1}\u0000`;
		});
	}
	return { text: result, values };
}

function compressProse(text: string, depth: 1 | 2 | 3): string {
	let result = text.replace(LITE_DROPS, "");
	for (const [pattern, replacement] of SHORTENINGS) result = result.replace(pattern, replacement);
	if (depth >= 2) {
		result = result
			.replace(/\b(?:the|a|an)\b\s*/giu, "")
			.replace(/\s+\b(?:is|are|was|were|be|been|being)\b\s+/giu, " ");
	}
	if (depth === 3)
		result = result
			.replace(/\b(?:and then|then after|afterwards|therefore)\b/giu, "->")
			.replace(/\bbecause(?: of)?\b/giu, "//")
			.replace(/\b(?:furthermore|additionally|as well as)\b/giu, "+")
			.replace(/ and /giu, " + ")
			.replace(/ or /giu, " | ");
	return result.replace(/^[\s,;:]+/u, "");
}

/** Deterministic text compression. Protected regions and `U: ` quotes survive byte-for-byte. */
export function cavemanCompress(text: string, depth: number | undefined): string {
	const level = LEVEL_BY_DEPTH[depth ?? 0];
	if (level === undefined || text.length === 0) return text;
	const { text: protectedText, values } = protect(text);
	const result = protectedText
		.split("\n")
		.map((line) => (line.startsWith("U: ") ? line : compressProse(line, depth as 1 | 2 | 3)))
		.join("\n")
		.replace(/[ \t]+/gu, " ")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
	return values.reduce(
		(current, value, index) => current.replaceAll(`\u0000${index}\u0000`, value),
		result,
	);
}
