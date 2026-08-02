import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
		expect(host.tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
		]);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
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
