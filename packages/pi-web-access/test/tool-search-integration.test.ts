import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createToolSearchToolDefinition } from "../../pi-ext-tools/src/tool-search.ts";
import webAccessExtension from "../src/index.ts";
import { toolHost } from "./fixtures/harness.ts";

describe("pi-web-access + tool_search integration", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-search-test-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	test.each([
		{ query: "search the web for docs", expectedTool: "web_search", callId: "call-1" },
		{
			query: "fetch url content and read webpage",
			expectedTool: "fetch_content",
			callId: "call-2",
		},
	])("tool_search discovers deferred $expectedTool and activates it", async ({
		query,
		expectedTool,
		callId,
	}) => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({
				webSearch: {
					toolExposure: "deferred",
				},
			}),
		);

		const host = toolHost(["read", "bash"]);
		webAccessExtension(host.pi);

		expect(host.activeTools()).toEqual(["read", "bash"]);
		expect(host.activeTools()).not.toContain(expectedTool);

		const toolSearch = createToolSearchToolDefinition(host.pi);
		const result = await toolSearch.execute(
			callId,
			{ query },
			undefined,
			undefined,
			undefined as never,
		);

		expect(result.details.loaded).toContain(expectedTool);
		expect(host.activeTools()).toContain(expectedTool);
	});
});
