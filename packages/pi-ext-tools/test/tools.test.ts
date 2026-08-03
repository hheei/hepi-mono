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
		expect(names).toEqual(["read", "grep", "find", "edit", "write", "bash", "apply_patch"]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
	});

	test("makes apply_patch exclusive with edit and write without splitting edit from write", (): void => {
		const host = harness();
		const controller = new AbortController();
		let inventory: readonly { readonly id: string; readonly conflictsWith?: readonly string[] }[] =
			[];
		observeLoadoutInventory(host.pi, {
			signal: controller.signal,
			onChange(items) {
				inventory = items;
			},
		});

		registerTools(host.pi);
		expect(inventory.find((tool) => tool.id === "apply_patch")).toMatchObject({
			conflictsWith: ["edit", "write"],
		});
		expect(inventory.find((tool) => tool.id === "edit")?.conflictsWith).toBeUndefined();
		expect(inventory.find((tool) => tool.id === "write")?.conflictsWith).toBeUndefined();
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
			text: "Done! Applied patch.\nFiles changed: 1\nOperations: 1\nExact updates: 0\nFuzzy updates: 0",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
	});

	test("preserves upstream write, edit, and bash execution semantics", async (): Promise<void> => {
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
		const bash = host.tools.find((tool) => tool.name === "bash");
		if (write === undefined || edit === undefined || bash === undefined)
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

		const result = await bash.execute(
			"bash-1",
			{ command: "printf canonical" },
			undefined,
			undefined,
			context,
		);
		expect(
			result.content.some(
				(part) => part.type === "text" && "text" in part && part.text.includes("canonical"),
			),
		).toBe(true);
	});
});
