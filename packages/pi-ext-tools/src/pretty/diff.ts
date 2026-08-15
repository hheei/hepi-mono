// Structured diff parsing — ported verbatim from @heyhuynhgiabuu/pi-diff
// (src/core/diff.ts). Wraps the `diff` npm package's structuredPatch into a
// flat line model the split/unified renderers consume.

import * as Diff from "diff";

/** Type-safe index into an array that noUncheckedIndexedAccess marks as T|undefined.
 *  Only call when the index is provably in-bounds (loop condition, length check, etc.). */
function at<T>(arr: T[], i: number): T {
	return arr[i] as T;
}

export interface DiffLine {
	type: "add" | "del" | "ctx" | "sep";
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

export interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	chars: number;
}

type StructuredPatch = ReturnType<typeof Diff.structuredPatch>;

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseDiff(
	oldContent: string,
	newContent: string,
	ctx = 3,
	// 1-based file line where the snippet begins; shifts gutter numbers from
	// snippet-relative to absolute. 0 = no shift (snippet-relative, the default).
	baseLine = 0,
): ParsedDiff {
	const patch = Diff.structuredPatch(
		"",
		"",
		normalizeLineEndings(oldContent),
		normalizeLineEndings(newContent),
		"",
		"",
		{
			context: ctx,
		},
	);
	return flattenPatch(patch, oldContent.length + newContent.length, baseLine);
}

/** Parses one persisted unified patch without consulting the current workspace. */
export function parseUnifiedPatch(patchText: string): ParsedDiff | undefined {
	try {
		const patches = Diff.parsePatch(normalizeLineEndings(patchText));
		const patch = patches.length === 1 ? patches[0] : undefined;
		if (patch === undefined || patch.hunks.length === 0) return undefined;
		return flattenPatch(patch, patchText.length, 0);
	} catch {
		return undefined;
	}
}

function flattenPatch(patch: StructuredPatch, chars: number, baseLine: number): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;

	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = at(patch.hunks, hi - 1);
			const gap = at(patch.hunks, hi).oldStart - (prev.oldStart + prev.oldLines);
			lines.push({
				type: "sep",
				oldNum: null,
				newNum: gap > 0 ? gap : null,
				content: "",
			});
		}
		const h = at(patch.hunks, hi);
		const shift = baseLine > 0 ? baseLine - 1 : 0;
		let oL = h.oldStart + shift;
		let nL = h.newStart + shift;
		for (const raw of h.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: nL++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oL++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oL++, newNum: nL++, content: text });
			}
		}
	}
	return {
		lines,
		added,
		removed,
		chars,
	};
}
