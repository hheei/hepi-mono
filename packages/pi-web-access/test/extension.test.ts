import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import webAccessExtension from "../src/index.ts";
import { toolFor, toolHost } from "./fixtures/harness.ts";

describe("pi-web-access extension", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-test-"));
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

	test("registers tools with deferred exposure and defaultActive false without web_enable", async () => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({
				webSearch: {
					toolExposure: "deferred",
				},
			}),
		);

		const host = toolHost();
		webAccessExtension(host.pi);

		const toolNames = host.tools.map((t) => t.name);
		expect(toolNames).toContain("web_search");
		expect(toolNames).toContain("fetch_content");
		expect(toolNames).toContain("source_check");
		expect(toolNames).toContain("get_search_content");
		expect(toolNames).not.toContain("web_enable");

		for (const name of ["web_search", "fetch_content", "source_check", "get_search_content"]) {
			const tool = toolFor(host.tools, name);
			expect(tool.exposure).toBe("deferred");
			expect((tool as { defaultActive?: boolean }).defaultActive).toBe(false);
		}
	});

	test("toolActivation deferred infers deferred exposure and omits web_enable", async () => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({
				webSearch: {
					toolActivation: "deferred",
				},
			}),
		);

		const host = toolHost();
		webAccessExtension(host.pi);

		const toolNames = host.tools.map((t) => t.name);
		expect(toolNames).not.toContain("web_enable");

		const search = toolFor(host.tools, "web_search");
		expect(search.exposure).toBe("deferred");
		expect((search as { defaultActive?: boolean }).defaultActive).toBe(false);
	});

	test("eager direct activation registers tools defaultActive true and omits web_enable", async () => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({
				webSearch: {
					toolExposure: "direct",
					toolActivation: "eager",
				},
			}),
		);

		const host = toolHost();
		webAccessExtension(host.pi);

		const toolNames = host.tools.map((t) => t.name);
		expect(toolNames).toContain("web_search");
		expect(toolNames).not.toContain("web_enable");

		const search = toolFor(host.tools, "web_search");
		expect(search.exposure).toBe("direct");
		expect((search as { defaultActive?: boolean }).defaultActive).toBe(true);
	});

	test("auto direct activation registers web_enable for dynamic loading", async () => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({
				webSearch: {
					toolExposure: "direct",
					toolActivation: "auto",
				},
			}),
		);

		const host = toolHost();
		webAccessExtension(host.pi);

		const toolNames = host.tools.map((t) => t.name);
		expect(toolNames).toContain("web_search");
		expect(toolNames).toContain("web_enable");
	});
});
