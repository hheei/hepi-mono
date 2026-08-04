import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";
import { registerTools } from "../src/tools.js";

const temporaryPaths: string[] = [];

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-ext-tools-"));
	temporaryPaths.push(path);
	return path;
}

function harness(): { readonly pi: ExtensionAPI; readonly tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	return {
		pi: {
			events: {},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		tools,
	};
}

describe("pi-ext-tools catalog", () => {
	test("registers each approved name exactly once through managed Loadout ownership", (): void => {
		const host = harness();
		registerTools(host.pi);
		const names = host.tools.map((tool) => tool.name);
		expect(names).toEqual([
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
			"bash_job",
			"apply_patch",
		]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
	});

	test("registers Built-in provenance and bidirectional mutator locks", (): void => {
		const host = harness();
		const controller = new AbortController();
		let inventory: readonly {
			readonly id: string;
			readonly group: string;
			readonly origin?: string;
			readonly conflictsWith?: readonly string[];
		}[] = [];
		observeLoadoutInventory(host.pi, {
			signal: controller.signal,
			onChange(items) {
				inventory = items;
			},
		});

		registerTools(host.pi);
		expect(inventory.find((tool) => tool.id === "apply_patch")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			conflictsWith: ["edit", "write"],
		});
		expect(inventory.find((tool) => tool.id === "edit")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			conflictsWith: ["apply_patch"],
		});
		expect(inventory.find((tool) => tool.id === "write")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			conflictsWith: ["apply_patch"],
		});
		expect(inventory.every((tool) => tool.group === "Built-in")).toBe(true);
		controller.abort();
	});

	test("registers apply_patch as strict V4A patch transport", (): void => {
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

		expect(applyPatch.parameters).toMatchObject({
			additionalProperties: false,
			required: ["patch"],
			properties: { patch: { type: "string" } },
		});
		const parameters: unknown = applyPatch.parameters;
		if (
			typeof parameters !== "object" ||
			parameters === null ||
			!("properties" in parameters) ||
			typeof parameters.properties !== "object" ||
			parameters.properties === null
		)
			throw new Error("apply_patch parameters are missing object properties");
		expect(Object.keys(parameters.properties)).toEqual(["patch"]);
		expect("prepareArguments" in applyPatch).toBe(false);
	});

	test("keeps upstream renderer contracts intact", (): void => {
		const host = harness();
		registerTools(host.pi);
		for (const [name, renderShell] of [
			["read", undefined],
			["grep", undefined],
			["find", undefined],
			["edit", "self"],
			["write", undefined],
			["bash", undefined],
		] as const) {
			const tool = host.tools.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`Missing ${name} tool`);
			expect(tool.renderShell).toBe(renderShell);
			expect(tool.renderCall).toBeDefined();
			expect(tool.renderResult).toBeDefined();
		}
	});

	test("uses pi-fff grep and find display formatting", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		};
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		const find = host.tools.find((candidate) => candidate.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing search tool");

		expect(
			grep
				.renderCall?.({ pattern: "needle", path: "src", timeout: 5 }, theme, {
					lastComponent: undefined,
				})
				.render(200)
				.join("\n")
				.trimEnd(),
		).toBe("grep /needle/ in src (timeout 5s)");
		expect(
			find
				.renderCall?.({ pattern: "status-surface", limit: 8 }, theme, { lastComponent: undefined })
				.render(200)
				.join("\n")
				.trimEnd(),
		).toBe("find status-surface (limit 8)");
	});

	test("executes read with the call context cwd instead of extension construction cwd", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "canonical\n", "utf8");
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");

		const result = await read.execute("read-1", { path: "value.txt" }, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		expect(result.content).toContainEqual({ type: "text", text: "canonical\n" });
	});

	test("executes apply_patch through its strict V4A transport", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

		const result = await applyPatch.execute(
			"apply-patch-1",
			{ patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch" },
			undefined,
			undefined,
			{ cwd } as ExtensionContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Done! Applied patch.\nStatus: Success\nFiles changed: 1\nOperations: 1\nExact updates: 0\nFuzzy updates: 0\nFuzzy matching: not used\nRejected operations: 0",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
	});

	test("reports rejected operation count rather than rejection group count", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

		const result = await applyPatch.execute(
			"apply-patch-conflict",
			{
				patch:
					"*** Begin Patch\n" +
					"*** Add File: created.txt\n+created\n" +
					"*** Add File: first.txt\n+first\n" +
					"*** Add File: first.txt\n+second\n" +
					"*** End Patch",
			},
			undefined,
			undefined,
			{ cwd } as ExtensionContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Applied patch partially.\nStatus: Partial\nFiles changed: 1\nOperations: 3\nExact updates: 0\nFuzzy updates: 0\nFuzzy matching: not used\nRejected operations: 2\nRejected paths: first.txt\nReason: path touched more than once: first.txt",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
		await expect(readFile(join(cwd, "first.txt"), "utf8")).rejects.toThrow();
	});

	test("preserves upstream write and edit execution semantics", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const context = {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext;
		const write = host.tools.find((tool) => tool.name === "write");
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (write === undefined || edit === undefined)
			throw new Error("catalog tool was not registered");

		await write.execute(
			"write-1",
			{ path: "value.txt", content: "before\n" },
			undefined,
			undefined,
			context,
		);
		await edit.execute(
			"edit-1",
			{ path: "value.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			context,
		);
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("after\n");
	});
});
