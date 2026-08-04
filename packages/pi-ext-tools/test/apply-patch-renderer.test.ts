import { describe, expect, test } from "bun:test";
import { renderApplyPatchCall } from "../src/apply-patch/renderer.js";
import { createApplyPatchTool } from "../src/apply-patch-tool.js";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

function output(patch: string, context: Record<string, unknown> = {}): string {
	return renderApplyPatchCall({ patch }, theme, context).render(200).join("\n");
}

describe("apply_patch call renderer", () => {
	test("summarizes create, edit, delete, and move without filesystem reads", () => {
		const text = output(
			"*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** Update File: old.txt\n*** Move to: moved.txt\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch",
		);
		expect(text).toContain("Edited 3 files +3 -1");
		expect(text).toContain("Created new.txt +2 -0");
		expect(text).toContain("Edited old.txt → moved.txt +1 -1");
		expect(text).toContain("Deleted gone.txt +0 -0");
	});

	test("expanded mode includes action lines and deltas", () => {
		const text = output(
			"*** Begin Patch\n*** Update File: x\n-old\n context\n+new\n*** End Patch",
			{ expanded: true },
		);
		expect(text).toContain("Edited x +1 -1");
		expect(text).toContain("- old");
		expect(text).toContain("+ new");
	});

	test("partial input gives streaming preview", () => {
		const text = output("*** Begin Patch\n*** Add File: stream.txt\n+one\n", {
			argsComplete: false,
		});
		expect(text).toContain("Created stream.txt +1 -0");
	});

	test("malformed complete input safely falls back to Patching", () => {
		expect(output("not a patch")).toContain("Patching");
	});

	test("result renderer shows hepi status summary without native Pi diff", () => {
		const renderResult = createApplyPatchTool().renderResult;
		if (renderResult === undefined) throw new Error("apply_patch result renderer is missing");
		const component = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Applied patch partially.\nStatus: Partial\nFuzzy matching: used",
					},
				],
				details: {
					status: "success",
					changedPaths: ["kept.txt"],
					operationCount: 2,
					exactUpdateCount: 0,
					fuzzyUpdateCount: 1,
					rejected: [],
				},
			},
			{ expanded: true, isPartial: false },
			{ fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
			{
				args: { patch: "*** Begin Patch\n*** End Patch" },
				cwd: process.cwd(),
				state: undefined,
			} as never,
		);
		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("Status: Partial");
		expect(rendered).toContain("Fuzzy matching: used");
		expect(rendered).not.toContain("--- a/kept.txt");
		expect(rendered).not.toContain("-1 old");
	});
});
