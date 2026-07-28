import { afterEach, describe, expect, test } from "bun:test";
import { replayTui, stripAnsi } from "../../hepi-debug/src/tui-replay.js";
import { clearApplyPatchRenderState } from "../../hepi-tools/src/pi-codex-tool/tools/apply-patch/render-state.js";
import {
	markAftApplyPatchFailure,
	renderAftApplyPatchCall,
	renderAftApplyPatchResult,
	startAftApplyPatchRender,
} from "../src/aft/apply-patch-renderer.js";
import { makeContext, makeResult, mockTheme, renderToString } from "./render-test-helpers.js";

const patchText = [
	"Explanation before the patch is allowed by AFT.",
	"*** Begin Patch",
	"*** Update File: src/example.ts",
	"@@",
	"-old",
	"+new",
	"*** Add File: src/new.ts",
	"+export {};",
	"*** End Patch",
].join("\n");

afterEach(clearApplyPatchRenderState);

describe("AFT apply_patch renderer", () => {
	test("uses the Codex patch summary for complete and streaming arguments", () => {
		const complete = renderToString(
			renderAftApplyPatchCall({ patchText }, mockTheme, makeContext({ patchText })),
		);
		expect(complete).toContain("Changed 2 files +2 -1");
		expect(complete).toContain("src/example.ts +1 -1");
		expect(complete).toContain("src/new.ts +1 -0");
		expect(
			renderToString(
				renderAftApplyPatchCall({ patchText: "*** Begin" }, mockTheme, {
					...makeContext({ patchText: "*** Begin" }),
					argsComplete: false,
				}),
			),
		).toContain("Patching");
	});

	test("keeps AFT recovery errors out of the TUI", () => {
		const args = { patchText };
		const preview = renderAftApplyPatchResult(
			makeResult("preview", { phase: "preview", paths: ["src/example.ts"] }),
			{ isPartial: true },
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(preview)).toBe("");

		const complete = renderAftApplyPatchResult(
			makeResult("Applied", { phase: "applied", paths: ["src/example.ts", "src/new.ts"] }),
			{},
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(complete)).toBe("");

		const error = renderAftApplyPatchResult(
			makeResult("apply_patch partially completed\nRecovery: read affected paths"),
			{},
			mockTheme,
			makeContext(args, { isError: true }),
		);
		expect(renderToString(error)).toBe("");
	});

	test("marks the failed patch target in the call summary", async () => {
		startAftApplyPatchRender("failed-call", patchText, "/workspace");
		markAftApplyPatchFailure(
			"failed-call",
			patchText,
			"/workspace",
			{ text: "src/new.ts: failed to apply" },
			false,
		);
		const rendered = renderToString(
			renderAftApplyPatchCall({ patchText }, mockTheme, {
				...makeContext({ patchText }),
				cwd: "/workspace",
				toolCallId: "failed-call",
			}),
		);
		expect(rendered).toContain("Edit failed");
		expect(rendered).toContain("src/new.ts failed");

		const result = await replayTui({
			columns: 48,
			rows: 10,
			create: () =>
				renderAftApplyPatchCall({ patchText }, mockTheme, {
					...makeContext({ patchText }),
					cwd: "/workspace",
					toolCallId: "failed-call",
				}),
		});
		expect(stripAnsi(result.last.lines.join("\n"))).toContain("src/new.ts failed");
	});

	test("replays the Codex summary in a narrow TUI frame", async () => {
		const result = await replayTui({
			columns: 48,
			rows: 10,
			create: () => renderAftApplyPatchCall({ patchText }, mockTheme, makeContext({ patchText })),
		});

		const frame = stripAnsi(result.last.lines.join("\n"));
		expect(frame).toContain("Changed 2 files +2 -1");
		expect(frame).toContain("src/example.ts +1 -1");
		expect(frame).not.toContain("patch applied");
	});

	test("does not replay AFT recovery text", async () => {
		const result = await replayTui({
			columns: 48,
			rows: 10,
			create: () =>
				renderAftApplyPatchResult(
					makeResult("Recovery: re-read affected paths"),
					{},
					mockTheme,
					makeContext({ patchText }, { isError: true }),
				),
		});

		expect(stripAnsi(result.last.lines.join("\n"))).not.toContain("Recovery:");
	});
});
