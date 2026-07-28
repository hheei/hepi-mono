import { afterEach, describe, expect, test } from "bun:test";
import {
	clearApplyPatchRenderState,
	markApplyPatchFailure,
	markApplyPatchPartialFailure,
	renderApplyPatchCallFromState,
	setApplyPatchRenderState,
} from "../../../src/pi-codex-tool/tools/apply-patch/render-state.js";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

function addFilePatch(path: string): string {
	return `*** Begin Patch\n*** Add File: ${path}\n+content\n*** End Patch`;
}

describe("apply_patch render state", () => {
	afterEach(() => clearApplyPatchRenderState());

	test("evicts the least recently used preview after the bounded cache limit", () => {
		setApplyPatchRenderState("first", addFilePatch("first.txt"), "/tmp");
		for (let index = 0; index < 50; index += 1)
			setApplyPatchRenderState(`call-${index}`, addFilePatch(`file-${index}.txt`), "/tmp");

		const rendered = renderApplyPatchCallFromState(
			{ input: addFilePatch("replacement.txt") },
			theme,
			{ toolCallId: "first", cwd: "/tmp", expanded: true },
		);
		expect(rendered).toContain("replacement.txt");
		expect(rendered).not.toContain("first.txt");
	});

	test("renders the collapsed summary with green additions and red removals", () => {
		const patch = addFilePatch("example.txt");
		const roles: string[] = [];
		const rendered = renderApplyPatchCallFromState(
			{ input: patch },
			{
				...theme,
				fg: (role, text) => {
					roles.push(role);
					return text;
				},
			},
			{ cwd: "/tmp" },
		);
		expect(rendered).toBe("apply_patch\n\nCreated example.txt +1 -0");
		expect(roles).toEqual(["accent", "dim", "success", "error", "accent"]);
	});

	test("renders a single edited file as an accent verb, dim path, and colored delta", () => {
		const patch = `*** Begin Patch
*** Update File: example.ts
@@
-old
-old-again
+new
+new-again
+another
*** End Patch`;
		const roles: string[] = [];
		const rendered = renderApplyPatchCallFromState(
			{ input: patch },
			{
				...theme,
				fg: (role, text) => {
					roles.push(role);
					return text;
				},
			},
			{ cwd: "/tmp" },
		);
		expect(rendered).toBe("apply_patch\n\nEdited example.ts +3 -2");
		expect(roles).toEqual(["accent", "dim", "success", "error", "accent"]);
	});

	test("incrementally renders complete streamed patch lines without executing the patch", () => {
		const state = {};
		const start = `*** Begin Patch
*** Update File: one.ts
@@
-old
`;
		expect(
			renderApplyPatchCallFromState({ input: start }, theme, {
				argsComplete: false,
				cwd: "/tmp",
				state,
			}),
		).toBe("apply_patch\n\nEdited one.ts +0 -1");

		const partialLine = `${start}+new`;
		expect(
			renderApplyPatchCallFromState({ input: partialLine }, theme, {
				argsComplete: false,
				cwd: "/tmp",
				state,
			}),
		).toBe("apply_patch\n\nEdited one.ts +0 -1");

		const nextAction = `${partialLine}
*** Add File: two.ts
+content
`;
		expect(
			renderApplyPatchCallFromState({ input: nextAction }, theme, {
				argsComplete: false,
				cwd: "/tmp",
				state,
			}),
		).toBe("apply_patch\n\nEdited one.ts +1 -1\nCreated two.ts +1 -0");
	});

	test("resets a streamed preview after the model replaces its argument prefix", () => {
		const state = {};
		renderApplyPatchCallFromState(
			{ input: "*** Begin Patch\n*** Update File: stale.ts\n@@\n-old\n" },
			theme,
			{ argsComplete: false, cwd: "/tmp", state },
		);
		expect(
			renderApplyPatchCallFromState(
				{ input: "*** Begin Patch\n*** Add File: replacement.ts\n+new\n" },
				theme,
				{ argsComplete: false, cwd: "/tmp", state },
			),
		).toBe("apply_patch\n\nCreated replacement.ts +1 -0");
	});

	test("does not invent a deleted line count from a streamed delete header", () => {
		const rendered = renderApplyPatchCallFromState(
			{ input: "*** Begin Patch\n*** Delete File: removed.ts\n" },
			theme,
			{ argsComplete: false, cwd: "/tmp", state: {} },
		);
		expect(rendered).toBe("apply_patch\n\nDeleted removed.ts");
	});

	test("stops the preview at End Patch and accepts strict-parser begin marker whitespace", () => {
		const state = {};
		expect(
			renderApplyPatchCallFromState(
				{
					input: `  *** Begin Patch${"   "}
*** Add File: kept.ts
+content
*** End Patch
*** Add File: ignored.ts
+content
`,
				},
				theme,
				{ argsComplete: false, cwd: "/tmp", state },
			),
		).toBe("apply_patch\n\nCreated kept.ts +1 -0");
	});

	test("falls back to Patching when streamed input exceeds the bounded preview limit", () => {
		const rendered = renderApplyPatchCallFromState(
			{
				input: `*** Begin Patch\n*** Add File: large.ts\n+${"x".repeat(256 * 1024)}\n`,
			},
			theme,
			{ argsComplete: false, cwd: "/tmp", state: {} },
		);
		expect(rendered).toBe("apply_patch\n\nPatching");
	});

	test("uses final-summary semantic colors while streaming patch arguments", () => {
		const styles: Array<readonly [string, string]> = [];
		const rendered = renderApplyPatchCallFromState(
			{
				input: `*** Begin Patch
*** Update File: changed.ts
@@
-old
+new
*** Add File: created.ts
+content
*** Delete File: removed.ts
`,
			},
			{
				...theme,
				fg: (role, text) => {
					styles.push([role, text]);
					return text;
				},
			},
			{ argsComplete: false, cwd: "/tmp", state: {} },
		);
		expect(rendered).toBe(
			"apply_patch\n\nEdited changed.ts +1 -1\nCreated created.ts +1 -0\nDeleted removed.ts",
		);
		expect(styles).toContainEqual(["accent", "Edited"]);
		expect(styles).toContainEqual(["dim", "changed.ts"]);
		expect(styles).toContainEqual(["success", "+1"]);
		expect(styles).toContainEqual(["error", "-1"]);
		expect(styles).toContainEqual(["accent", "Created"]);
		expect(styles).toContainEqual(["dim", "created.ts"]);
		expect(styles).toContainEqual(["error", "-0"]);
		expect(styles).toContainEqual(["accent", "Deleted"]);
		expect(styles).toContainEqual(["dim", "removed.ts"]);
		expect(styles).toContainEqual(["accent", "apply_patch"]);
	});

	test("renders a colored aggregate and every changed target", () => {
		const patch = `*** Begin Patch
*** Update File: one.ts
@@
-old
+new
*** Update File: two.ts
@@
-old
+new
*** Update File: three.ts
@@
-old
+new
*** End Patch`;
		expect(renderApplyPatchCallFromState({ input: patch }, theme, { cwd: "/tmp" })).toBe(
			[
				"apply_patch",
				"",
				"Edited 3 files +3 -3",
				"",
				"one.ts +1 -1",
				"two.ts +1 -1",
				"three.ts +1 -1",
			].join("\n"),
		);
	});

	test("labels a single deleted file in one line", () => {
		const patch = `*** Begin Patch
*** Delete File: removed.ts
*** End Patch`;
		expect(renderApplyPatchCallFromState({ input: patch }, theme, { cwd: "/tmp" })).toBe(
			"apply_patch\n\nDeleted removed.ts +0 -0",
		);
	});

	test("uses semantic status colors without a bullet prefix", () => {
		const patch = addFilePatch("example.txt");
		setApplyPatchRenderState("failed", patch, "/tmp");
		markApplyPatchFailure("failed", "failed", ["example.txt"]);
		setApplyPatchRenderState("partial", patch, "/tmp");
		markApplyPatchPartialFailure("partial", ["example.txt"]);
		const roles: string[] = [];
		const coloredTheme = {
			...theme,
			fg: (role: string, text: string) => {
				roles.push(role);
				return text;
			},
		};
		expect(
			renderApplyPatchCallFromState({ input: patch }, coloredTheme, {
				toolCallId: "failed",
				cwd: "/tmp",
			}),
		).toBe("apply_patch\n\nEdit failed 1 file +1 -0\n\nexample.txt failed");
		expect(
			renderApplyPatchCallFromState({ input: patch }, coloredTheme, {
				toolCallId: "partial",
				cwd: "/tmp",
			}),
		).toBe("apply_patch\n\nEdit partially failed 1 file +1 -0\n\nexample.txt failed");
		expect(roles).toEqual([
			"error",
			"success",
			"error",
			"dim",
			"error",
			"accent",
			"accent",
			"warning",
			"success",
			"error",
			"dim",
			"error",
			"accent",
		]);
	});

	test("leaves failed file counts unstyled while coloring aggregate deltas", () => {
		const patch = `*** Begin Patch
*** Update File: example.txt
@@
-old
+new
*** End Patch`;
		setApplyPatchRenderState("failed-counts", patch, "/tmp");
		markApplyPatchFailure("failed-counts", "failed", ["example.txt"]);
		const styles: Array<readonly [string, string]> = [];
		const rendered = renderApplyPatchCallFromState(
			{ input: patch },
			{
				...theme,
				fg: (role, text) => {
					styles.push([role, text]);
					return text;
				},
			},
			{ toolCallId: "failed-counts", cwd: "/tmp" },
		);
		expect(rendered).toContain("Edit failed 1 file +1 -1");
		expect(styles).toContainEqual(["error", "Edit failed"]);
		expect(styles).toContainEqual(["success", "+1"]);
		expect(styles).toContainEqual(["error", "-1"]);
		expect(styles).not.toContainEqual(["error", " 1 file "]);
		expect(styles).not.toContainEqual(["warning", " 1 file "]);
	});

	test("keeps partial failure counts plain and colors its aggregate deltas", () => {
		const patch = `*** Begin Patch
*** Update File: one.ts
@@
-one
-two
-three
-four
-five
-six
-seven
+one
+two
+three
+four
+five
+six
+seven
*** Update File: two.ts
@@
 context
*** End Patch`;
		setApplyPatchRenderState("partial-counts", patch, "/tmp");
		markApplyPatchPartialFailure("partial-counts", ["one.ts"]);
		const styles: Array<readonly [string, string]> = [];
		const rendered = renderApplyPatchCallFromState(
			{ input: patch },
			{
				...theme,
				fg: (role, text) => {
					styles.push([role, text]);
					return text;
				},
			},
			{ toolCallId: "partial-counts", cwd: "/tmp" },
		);
		expect(rendered).toContain("Edit partially failed 2 files +7 -7");
		expect(styles).toContainEqual(["accent", "Edit"]);
		expect(styles).toContainEqual(["warning", " partially failed"]);
		expect(styles).toContainEqual(["success", "+7"]);
		expect(styles).toContainEqual(["error", "-7"]);
		expect(styles).not.toContainEqual(["warning", " 2 files "]);
	});
});
