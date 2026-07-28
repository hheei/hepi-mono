import { describe, expect, test } from "bun:test";
import {
	renderOutlineCall,
	renderOutlineResult,
	renderZoomCall,
	renderZoomResult,
} from "../src/aft/reading-renderers.js";
import { makeContext, makeResult, mockTheme, renderToString } from "./render-test-helpers.js";

describe("AFT reading renderers", () => {
	test("renders outline call and structured result", () => {
		const args = { target: "src" };
		expect(renderToString(renderOutlineCall(args, mockTheme, makeContext(args)))).toContain("src");
		const result = renderOutlineResult(
			makeResult("src\n  module example"),
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(result)).toContain("module example");
	});

	test("renders zoom calls, results, and errors", () => {
		const args = { path: "src/example.ts", symbols: ["example", "helper"] };
		expect(renderToString(renderZoomCall(args, mockTheme, makeContext(args)))).toContain(
			"2 symbols",
		);
		const result = renderZoomResult(
			makeResult("", { name: "example", kind: "function", content: "return 1;" }),
			args,
			mockTheme,
			makeContext(args),
		);
		expect(renderToString(result)).toContain("return 1;");
		const error = renderZoomResult(
			makeResult("zoom failed"),
			args,
			mockTheme,
			makeContext(args, { isError: true }),
		);
		expect(renderToString(error)).toContain("zoom failed");
	});
});
