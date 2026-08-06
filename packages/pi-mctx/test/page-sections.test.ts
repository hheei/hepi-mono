import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KnowledgeSection } from "@hheei/pi-ext-core";
import {
	buildKnowledgeSectionIndex,
	latestUserQuery,
	pageSectionBudget,
	pageSectionsMessage,
	selectKnowledgeSections,
} from "../src/page-sections.js";

function section(overrides: Partial<KnowledgeSection> = {}): KnowledgeSection {
	return {
		id: "page-1:0",
		pageId: "page-1",
		pageName: "Architecture",
		heading: "Ownership",
		text: "Keep package ownership explicit.",
		sourceVersion: "version-1",
		provenance: ["bank:project-bank", "knowledge-page:page-1"],
		scopeTags: ["project:repo"],
		...overrides,
	};
}

test("indexes scoped sections and ranks heading matches above body matches", (): void => {
	const index = buildKnowledgeSectionIndex([
		section({ text: "Package boundaries." }),
		section({ id: "page-1:1", heading: "Storage", text: "Ownership boundaries." }),
	]);
	expect(index).toBeDefined();
	if (index === undefined) throw new Error("Expected valid section index");
	const selected = selectKnowledgeSections(index, "ownership boundaries", 10_000);
	expect(selected.map(({ section: value }) => value.heading)).toEqual(["Ownership", "Storage"]);
	expect(selected[0]?.score).toBeGreaterThan(selected[1]?.score ?? 0);
});

test("rejects duplicate sections, bounds rendering, and marks only rendered sources", (): void => {
	const duplicate = buildKnowledgeSectionIndex([section(), section()]);
	expect(duplicate).toBeUndefined();
	expect(
		buildKnowledgeSectionIndex([section({ scopeTags: ["project:other"] })], undefined, [
			"project:repo",
		]),
	).toBeUndefined();
	const index = buildKnowledgeSectionIndex([section({ text: "x".repeat(4_000) })]);
	expect(index).toBeDefined();
	if (index === undefined) throw new Error("Expected valid section index");
	const selected = selectKnowledgeSections(index, "ownership", 300);
	const message = pageSectionsMessage(selected, 300);
	expect(message).toBeDefined();
	if (message === undefined) throw new Error("Expected page message");
	if (message.role !== "custom" || typeof message.content !== "string")
		throw new Error("Expected custom string page message");
	expect(message.content.length).toBeLessThanOrEqual(300);
	expect(message.details).toMatchObject({ sourceIds: ["page-1:0"], retain: false });
});

test("extracts latest multimodal user text and applies pressure budget", (): void => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "find ownership" }], timestamp: 3 },
	];
	expect(latestUserQuery(messages)).toBe("find ownership");
	expect(pageSectionBudget(10_000, 7_500)).toBe(1_400);
	expect(pageSectionBudget(10_000, 8_500)).toBe(0);
});
