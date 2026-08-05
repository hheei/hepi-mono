import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTestModel } from "@hheei/pi-ext-core/testing";
import { BTW_CHILD_BUILTIN_TOOLS, createBtwChildFactory } from "../../src/child.js";

const model = createTestModel({
	provider: "test",
	id: "btw-child-model",
	api: "openai-completions",
}) as Model<Api>;

test("BTW child exposes only repository read tools", async (): Promise<void> => {
	const context = { cwd: process.cwd() } as ExtensionContext;
	const session = await createBtwChildFactory(context, {
		model,
		systemPrompt: "Read-only test child",
	}).create(new AbortController().signal);
	try {
		expect(session.getActiveToolNames()).toEqual([...BTW_CHILD_BUILTIN_TOOLS]);
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([...BTW_CHILD_BUILTIN_TOOLS].sort());
	} finally {
		session.dispose();
	}
});
