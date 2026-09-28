import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { registerEvalTool } from "../src/eval/tool.js";
import { framedHost } from "./fixtures/harness.js";
import { plainTheme } from "./fixtures/theme.js";

describe("Eval tool frame", () => {
	const callRows = (args: Record<string, unknown>, width = 120): string[] => {
		const { pi, tools, tui } = framedHost();
		registerEvalTool(
			pi,
			{ getRuntime: () => undefined } as unknown as EvalRuntimeState,
			new EvalToolBridge(new Map(), () => true),
			tui,
		);
		const evalTool = tools[0]!;
		return (
			evalTool
				.renderCall?.(args, plainTheme, {
					isError: false,
					isPartial: true,
					lastComponent: undefined,
					state: {},
				} as never)
				?.render(width) ?? []
		);
	};

	test("states the call markers in the header and keeps the code in a request body", () => {
		const rows = callRows({ code: "import math\nmath.sqrt(16)", reset: true, timeout: 30 });
		expect(rows[0]).toContain("eval py import math; math.sqrt(16) (reset) (timeout 30s)");
		expect(rows[1]).toBe("─".repeat(120));
		expect(rows[2]).toBe("import math");
		expect(rows[3]).toBe("math.sqrt(16)");
		expect(rows[4]).toBe("─".repeat(120));
	});

	test("omits the marker suffix when the call declares no markers", () => {
		const rows = callRows({ code: "value = 1" });
		expect(rows[0]).toContain("eval py value = 1");
		expect(rows[0]).not.toContain("(");
		expect(rows[2]).toBe("value = 1");
	});

	test("wraps a wide code line instead of cutting it", () => {
		const code = `value = "${"x".repeat(60)}"`;
		const rows = callRows({ code }, 40);
		const body = rows.slice(2, -1);
		// Wrapping drops the space it breaks on, so compare with whitespace removed.
		expect(body.join("").replace(/ /gu, "")).toBe(code.replace(/ /gu, ""));
		expect(body.length).toBeGreaterThan(1);
		expect(body.every((row) => row.length <= 40)).toBe(true);
	});
});
