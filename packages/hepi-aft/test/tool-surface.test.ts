import { describe, expect, test } from "bun:test";
import { resolveHepiAftToolSurface } from "../src/aft/tool-surface.js";

describe("AFT tool surface", () => {
	test("does not register tools when AFT is disabled", () => {
		const surface = resolveHepiAftToolSurface({ enabled: false });
		expect(surface).toMatchObject({ enabled: false, read: false, bash: false, outline: false });
	});

	test("honors minimal, disabled tools, bash, and inspect switches", () => {
		const surface = resolveHepiAftToolSurface({
			tool_surface: "minimal",
			bash: false,
			disabled_tools: ["aft_outline", "aft_safety"],
			inspect: { enabled: false },
		});
		expect(surface).toMatchObject({
			bash: false,
			read: false,
			write: false,
			edit: false,
			applyPatch: false,
			outline: false,
			zoom: true,
			safety: false,
			inspect: false,
			importTool: false,
			callgraph: false,
			refactor: false,
		});
	});

	test("exposes all-only structure tools only on the all surface", () => {
		expect(resolveHepiAftToolSurface({ tool_surface: "recommended" })).toMatchObject({
			callgraph: false,
			refactor: false,
		});
		expect(resolveHepiAftToolSurface({ tool_surface: "all" })).toMatchObject({
			callgraph: true,
			refactor: true,
		});
	});
});
