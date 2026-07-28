import { describe, expect, test } from "bun:test";
import {
	renderAftApplyPatchCall,
	renderAftApplyPatchResult,
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

describe("AFT apply_patch renderer", () => {
	test("summarizes complete and streaming patch arguments", () => {
		expect(
			renderToString(renderAftApplyPatchCall({ patchText }, mockTheme, makeContext({ patchText }))),
		).toContain("2 file actions");
		expect(
			renderToString(
				renderAftApplyPatchCall({ patchText: "*** Begin" }, mockTheme, {
					...makeContext({ patchText: "*** Begin" }),
					argsComplete: false,
				}),
			),
		).toContain("Patching...");
	});

	test("renders bridge preview, completion, and recovery errors", () => {
		const args = { patchText };
		const preview = renderAftApplyPatchResult(
			makeResult("preview", { phase: "preview", paths: ["src/example.ts"] }),
			{ isPartial: true },
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(preview)).toContain("patch validated");
		expect(renderToString(preview)).toContain("src/example.ts");

		const complete = renderAftApplyPatchResult(
			makeResult("Applied", { phase: "applied", paths: ["src/example.ts", "src/new.ts"] }),
			{},
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(complete)).toContain("patch applied");
		expect(renderToString(complete)).toContain("src/new.ts");

		const error = renderAftApplyPatchResult(
			makeResult("apply_patch partially completed\nRecovery: read affected paths"),
			{},
			mockTheme,
			makeContext(args, { isError: true }),
		);
		expect(renderToString(error)).toContain("Recovery: read affected paths");
	});
});
