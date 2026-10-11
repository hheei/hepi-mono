import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
