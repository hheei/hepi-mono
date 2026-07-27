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
			"accent",
			"error",
			"dim",
			"error",
			"accent",
			"accent",
			"warning",
			"dim",
			"error",
			"accent",
		]);
	});
});
