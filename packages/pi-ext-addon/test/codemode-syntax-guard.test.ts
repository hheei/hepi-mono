import { Script } from "node:vm";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	CODEMODE_WRAPPER_PREFIX,
	checkCodemodeSyntax,
	createCodemodeSyntaxGuard,
	formatCodemodeSyntaxError,
	parseCodemodeSyntaxDiagnostics,
	wrapCodemodeSource,
} from "../src/codemode-syntax-guard.js";

const BACKTICK = "`";

function compileError(code: string): SyntaxError {
	try {
		new Script(wrapCodemodeSource(code), { filename: "codemode.js" });
	} catch (error) {
		if (error instanceof SyntaxError) return error;
		throw error;
	}
	throw new Error("expected a syntax error");
}

function reasonFor(code: string): string {
	const reason = checkCodemodeSyntax(code);
	if (reason === undefined) throw new Error(`expected a syntax error for: ${code}`);
	return reason;
}

function callEvent(input: unknown, options: { parentToolCallId?: string } = {}): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "codemode",
		input,
		...(options.parentToolCallId === undefined
			? {}
			: { parentToolCallId: options.parentToolCallId }),
	} as ToolCallEvent;
}

describe("wrapCodemodeSource", () => {
	it("matches the pi-codemode runtime wrapper so line numbers line up", () => {
		expect(wrapCodemodeSource("const a = 1;")).toBe(`${CODEMODE_WRAPPER_PREFIX}const a = 1;\n})`);
	});
});

describe("checkCodemodeSyntax", () => {
	it("accepts runnable scripts", () => {
		expect(checkCodemodeSyntax("const a = 1;\nreturn { a };")).toBeUndefined();
		expect(checkCodemodeSyntax("await tools.read({ path: 'x' });")).toBeUndefined();
		expect(
			checkCodemodeSyntax(`const t = ${BACKTICK}plain text${BACKTICK};\ntext(t);`),
		).toBeUndefined();
	});

	it("accepts a first-line @options comment, as pi-codemode does", () => {
		expect(
			checkCodemodeSyntax('// @options: {"max_output_tokens": 2000}\nconst a = 1;'),
		).toBeUndefined();
	});

	it("reports the offending line and caret for an unescaped backtick", () => {
		const code = `const a = 1;\nconst t = ${BACKTICK}x${BACKTICK} and ${BACKTICK}y${BACKTICK};`;
		const reason = reasonFor(code);
		expect(reason).toContain("SyntaxError: Unexpected identifier");
		expect(reason).toContain("2 | const t = `x` and `y`;");
	});

	it("strips the wrapper prefix when the error is on line 1", () => {
		const reason = reasonFor(`${BACKTICK}a${BACKTICK} b`);
		expect(reason).toContain("1 | `a` b");
		expect(reason).not.toContain(CODEMODE_WRAPPER_PREFIX);
	});

	it("reports end-of-script failures without echoing the wrapper suffix", () => {
		const reason = reasonFor("if (true) {");
		expect(reason).toContain("end of script");
		expect(reason).not.toContain("})");
	});

	it("clips a very long offending line around the caret", () => {
		const long = `${"x".repeat(400)} ${BACKTICK}bad${BACKTICK} ${"y".repeat(400)}`;
		const reason = reasonFor(long);
		const reported = reason.split("\n").find((line) => line.includes("…"));
		expect(reported).toBeDefined();
		expect((reported ?? "").length).toBeLessThan(200);
	});
});

describe("parseCodemodeSyntaxDiagnostics", () => {
	it("returns line, source text, and caret span", () => {
		const diagnostics = parseCodemodeSyntaxDiagnostics(compileError("const a = 1;\nvar b = ;"));
		expect(diagnostics.line).toBe(2);
		expect(diagnostics.sourceLine).toBe("var b = ;");
		expect(diagnostics.caretStart).toBe(8);
		expect(diagnostics.caretEnd).toBe(8);
	});

	it("degrades to the message when the stack has no position", () => {
		const bare = new SyntaxError("boom");
		bare.stack = "SyntaxError: boom";
		expect(parseCodemodeSyntaxDiagnostics(bare)).toEqual({ message: "boom" });
	});
});

describe("formatCodemodeSyntaxError", () => {
	it("keeps a multi-character caret span", () => {
		const code = `const a = 1;\nconst t = ${BACKTICK}x${BACKTICK} node${BACKTICK}y${BACKTICK};`;
		const text = formatCodemodeSyntaxError(compileError(code), code);
		expect(text).toContain("Unexpected identifier 'node'");
		expect(text).toMatch(/\^{4}/);
	});
});

describe("createCodemodeSyntaxGuard", () => {
	const guard = createCodemodeSyntaxGuard();

	it("blocks an uncompilable script with a repair reason", () => {
		const result = guard(callEvent({ code: "const a = ;" }));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("SyntaxError:");
		expect(result?.terminate).toBeUndefined();
	});

	it("passes runnable scripts through", () => {
		expect(guard(callEvent({ code: "text(await tools.read({ path: 'a' }));" }))).toBeUndefined();
	});

	it("ignores other tools and nested calls", () => {
		expect(guard({ ...callEvent({ code: "const a = ;" }), toolName: "bash" })).toBeUndefined();
		expect(
			guard(callEvent({ code: "const a = ;" }, { parentToolCallId: "parent-1" })),
		).toBeUndefined();
	});

	it("ignores input that is not a script", () => {
		expect(guard(callEvent({ code: 42 }))).toBeUndefined();
		expect(guard(callEvent({ code: "   " }))).toBeUndefined();
		expect(guard(callEvent({}))).toBeUndefined();
	});

	it("leaves QuickJS-only failures to the tool", () => {
		const deep = `${"(".repeat(4000)}1${")".repeat(4000)}`;
		expect(guard(callEvent({ code: deep }))).toBeUndefined();
	});
});
