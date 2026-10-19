import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	hasOptionalToolRenderers,
	registerExtensionHook,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { describe, expect, it, vi } from "vitest";

import {
	formatRecallCallForTui,
	formatRecallRenderedResultForTui,
	OM_RECALL_EVIDENCE_TOOL_NAME,
	omRecallEvidenceTool,
	RECALL_OBSERVATION_TOOL_NAME,
	recallObservationTool,
	registerRecallEvidenceTool,
	registerRecallTool,
} from "../src/tools/om-recall-evidence.js";
import {
	gateEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2ObservationEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("recall tool must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries } }, getBranch, getEntries };
}

async function execute(id: string, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const rawResult = await omRecallEvidenceTool.execute(
		"tool-1",
		{ id },
		undefined as unknown as AbortSignal,
		undefined as unknown as (update: unknown) => void,
		ctx as unknown as Parameters<typeof omRecallEvidenceTool.execute>[4],
	);
	const result = rawResult as unknown as {
		content: (typeof rawResult)["content"];
		details?: Record<string, unknown> & {
			matches: Array<{ observation: { status: string } }>;
			status?: string;
		};
	};
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { result, text, getBranch, getEntries };
}

describe("om_recall_evidence tool", () => {
	it("keeps the public tool name, metadata, and TUI call rendering", () => {
		const pi = { registerTool: vi.fn() };
		registerRecallEvidenceTool(pi as unknown as ExtensionAPI);

		expect(OM_RECALL_EVIDENCE_TOOL_NAME).toBe("om_recall_evidence");
		expect(RECALL_OBSERVATION_TOOL_NAME).toBe("om_recall_evidence");
		expect(omRecallEvidenceTool.name).toBe("om_recall_evidence");
		expect(recallObservationTool).toBe(omRecallEvidenceTool);
		expect(registerRecallTool).toBe(registerRecallEvidenceTool);
		expect(recallObservationTool.label).toBe("Recall memory evidence");
		expect(formatRecallCallForTui("aaaaaaaaaaaa")).toBe("om_recall_evidence aaaaaaaaaaaa");
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "om_recall_evidence", label: "Recall memory evidence" }),
		);
	});

	it("renders active observation source evidence", async () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User likes tea.",
			sourceEntryIds: ["raw-1"],
		});
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
		];

		const { result, text, getBranch, getEntries } = await execute("aaaaaaaaaaaa", entries);

		expect(getBranch).toHaveBeenCalledOnce();
		expect(getEntries).not.toHaveBeenCalled();
		expect(result.details?.status).toBe("ok");
		expect(result.details?.matches[0]?.observation.status).toBe("active");
		expect(text).toContain("I like tea.");
		expect(
			formatRecallRenderedResultForTui(
				result as unknown as Parameters<typeof formatRecallRenderedResultForTui>[0],
				false,
			),
		).toContain("󰄴 observation");
		expect(
			formatRecallRenderedResultForTui(
				result as unknown as Parameters<typeof formatRecallRenderedResultForTui>[0],
				false,
			),
		).toContain("󰄴 success");
	});

	it("renders dropped observations as recallable but dropped", async () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User likes tea.",
			sourceEntryIds: ["raw-1"],
		});
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "om-obs",
			}),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);
		const tui = formatRecallRenderedResultForTui(
			result as unknown as Parameters<typeof formatRecallRenderedResultForTui>[0],
			false,
		);

		expect(result.details?.matches[0]?.observation.status).toBe("dropped");
		expect(text).toContain("dropped from active memory but remains recallable");
		expect(tui).toContain("[dropped]");
		expect(tui).toContain("󰀪 note");
	});

	it("renders reflection recall with supporting observations and sources", async () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User likes tea.",
			sourceEntryIds: ["raw-1"],
		});
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User likes tea." });
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("eeeeeeeeeeee", entries);

		expect(result.details?.status).toBe("ok");
		expect(result.details?.reflections).toHaveLength(1);
		expect(result.details?.observations).toHaveLength(1);
		expect(text).toContain("Reflections:");
		expect(text).toContain("[eeeeeeeeeeee] User likes tea.");
		expect(text).toContain("Observations:");
		expect(text).toContain("Sources:");
		expect(text).toContain("I like tea.");
	});

	it("reports missing sources as partial", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["missing-raw"] });
		const entries = [
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "om-obs" }),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("partial");
		expect(result.details?.missingSourceEntryIds).toEqual(["missing-raw"]);
		expect(text).toContain("missing: missing-raw");
	});

	it("reports invalid ids without reading the branch", async () => {
		const { result, text, getBranch } = await execute("not-valid", []);

		expect(result.details?.status).toBe("invalid_id");
		expect(text).toContain("Memory id must be 12 lowercase hex characters");
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("reports not found and ignores old V2 memory", async () => {
		const entries = [oldV2ObservationEntry("v2-obs")];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("not_found");
		expect(text).toContain("No observation or reflection with id aaaaaaaaaaaa was found");
		expect(
			formatRecallRenderedResultForTui(
				result as unknown as Parameters<typeof formatRecallRenderedResultForTui>[0],
				false,
			),
		).toContain("󰀪 not found");
	});

	it("answers with the disabled notice instead of a memory when the session gate is off", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const entries = [
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			rawMessage("raw-1", "source text"),
			gateEntry("gate-1", false),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("disabled");
		expect(text).toContain("om is off for this session");
		expect(text).toContain("/om on");
		expect(
			formatRecallRenderedResultForTui(
				result as unknown as Parameters<typeof formatRecallRenderedResultForTui>[0],
				false,
			),
		).toContain("󰀪 disabled");
		expect(text).not.toContain("source text");
	});

	it("recalls normally again after the gate is turned back on", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const entries = [
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			rawMessage("raw-1", "source text"),
			gateEntry("gate-1", false),
			gateEntry("gate-2", true),
		];

		const { result, text } = await execute("aaaaaaaaaaaa", entries);

		expect(result.details?.status).toBe("ok");
		expect(text).toContain("source text");
	});

	it("defines readOnlyHint and idempotentHint annotations for 1.0.0 codemode and scheduling", () => {
		expect(recallObservationTool.annotations).toEqual({
			readOnlyHint: true,
			idempotentHint: true,
		});
	});
});

const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;
const plainContext = { args: {}, isError: false, isPartial: false } as never;

function registeredTool(): { pi: ExtensionAPI; tool: ToolDefinition } {
	let registered: ToolDefinition | undefined;
	const pi = {
		registerTool(tool: ToolDefinition) {
			registered = tool;
		},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	registerRecallEvidenceTool(pi);
	if (registered === undefined) throw new Error("om_recall_evidence was not registered");
	return { pi, tool: registered };
}

function renderRows(
	tool: ToolDefinition,
	args: unknown,
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
	expanded = false,
): { readonly call: string; readonly output: string } {
	if (tool.renderCall === undefined || tool.renderResult === undefined)
		throw new Error("missing renderers");
	// Text pads every row to the requested width; assertions read logical lines.
	const rows = (component: { render(width: number): string[] }): string =>
		component
			.render(80)
			.map((line) => line.trimEnd())
			.filter((line) => line !== "")
			.join("\n");
	return {
		call: rows(tool.renderCall(args as never, plainTheme, plainContext)),
		output: rows(
			tool.renderResult!(result as never, { expanded, isPartial: false }, plainTheme, plainContext),
		),
	};
}

describe("om_recall_evidence native renderers", () => {
	it("the definition ships renderers, while registration wraps them for optional UI", () => {
		expect(omRecallEvidenceTool.renderCall).toBeTypeOf("function");
		expect(omRecallEvidenceTool.renderResult).toBeTypeOf("function");
		expect(omRecallEvidenceTool.renderShell).toBeUndefined();

		const { tool } = registeredTool();
		expect(tool.renderShell).toBe("self");
		expect(hasOptionalToolRenderers(tool)).toBe(true);
		expect(tool.name).toBe(OM_RECALL_EVIDENCE_TOOL_NAME);
		expect(tool.label).toBe("Recall memory evidence");
	});

	it("renders the call and result rows without any UI package", async () => {
		const { tool } = registeredTool();
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
				coversUpToId: "raw-1",
			}),
		];
		const { result } = await execute("aaaaaaaaaaaa", entries);
		const collapsed = renderRows(tool, { id: "aaaaaaaaaaaa" }, result);
		expect(collapsed.call).toBe("om_recall_evidence aaaaaaaaaaaa");
		expect(collapsed.output).toContain("󰄴 success");
		expect(collapsed.output).toContain("(Ctrl+O to expand)");
		expect(collapsed.output).not.toContain("I like tea.");
		const expanded = renderRows(tool, { id: "aaaaaaaaaaaa" }, result, true);
		expect(expanded.output).toContain("I like tea.");
		expect(stripTerminalSequences(expanded.output)).toBe(expanded.output);
	});

	it("keeps every rendered row inside the terminal width", async () => {
		const { tool } = registeredTool();
		const entries = [
			rawMessage("raw-1", "I like tea."),
			observationsRecordedEntry("om-obs", {
				observations: [
					observation("aaaaaaaaaaaa", {
						content: `用户偏好长行：\u001b[31m${"很长的观察内容".repeat(6)}`,
						sourceEntryIds: ["raw-1"],
					}),
				],
				coversUpToId: "raw-1",
			}),
		];
		const { result } = await execute("aaaaaaaaaaaa", entries);
		for (const width of [12, 40, 80]) {
			const rows = [
				...tool.renderCall!({ id: "aaaaaaaaaaaa" }, plainTheme, plainContext).render(width),
				...tool.renderResult!(
					result as never,
					{ expanded: true, isPartial: false },
					plainTheme,
					plainContext,
				).render(width),
			];
			expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(rows.join("").includes("\u001b[31m")).toBe(false);
		}
	});

	it("keeps the model-visible error text when the result has no details", () => {
		const { tool } = registeredTool();
		const rows = renderRows(
			tool,
			{ id: "aaaaaaaaaaaa" },
			{
				content: [{ type: "text", text: "Runtime unavailable" }],
			},
		);
		expect(rows.output).toBe("Runtime unavailable");
	});

	it("strips terminal escapes from the model-supplied id", () => {
		const { tool } = registeredTool();
		const rows = renderRows(
			tool,
			{ id: "aaaaaaaaaaaa\u001b[2J\u001b]0;pwn\u0007" },
			{ content: [{ type: "text", text: "no details" }] },
		);
		expect(rows.call).toBe("om_recall_evidence aaaaaaaaaaaa");
		expect(formatRecallCallForTui("aaaaaaaaaaaa\u001b[31m")).toBe(
			"om_recall_evidence aaaaaaaaaaaa",
		);
	});

	it("a loaded UI factory decorates the native renderers and disposing restores them", async () => {
		const { pi, tool } = registeredTool();
		const args = { id: "aaaaaaaaaaaa" };
		const result = { content: [{ type: "text" as const, text: "no details" }] };
		expect(renderRows(tool, args, result).call).toBe("om_recall_evidence aaaaaaaaaaaa");

		const handle = registerExtensionHook(pi, toolRendererPoint, (name, native) => {
			if (name !== OM_RECALL_EVIDENCE_TOOL_NAME) return native;
			return { renderShell: "self", renderCall: () => new Text("rich recall", 0, 0) };
		});
		await handle.ready;
		expect(stripTerminalSequences(renderRows(tool, args, result).call)).toBe("rich recall");

		await handle.dispose();
		expect(renderRows(tool, args, result).call).toBe("om_recall_evidence aaaaaaaaaaaa");
	});
});
