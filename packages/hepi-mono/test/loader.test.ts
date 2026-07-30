import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeLoadoutGroupRegistry } from "../../hepi-basics/src/core/index.js";
import { hepiExtensions } from "../src/index.js";

describe("unified HEPI loader", () => {
	test("keeps foundational registration first and loads each runtime module once", async () => {
		expect(hepiExtensions.length).toBeGreaterThanOrEqual(17);
		expect(new Set(hepiExtensions).size).toBe(hepiExtensions.length);
		expect(hepiExtensions[0]?.name).toBe("piBasicsExtension");
		expect(hepiExtensions[1]?.name).toBe("piLoadoutExtension");
		expect(hepiExtensions.some((extension) => extension.name === "piDebugExtension")).toBe(false);
	});

	test("publishes one Pi extension entry and the bundled skills", async () => {
		const manifest: unknown = JSON.parse(
			await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
		);
		expect(manifest).toMatchObject({
			pi: { extensions: ["./dist/extension.js"], skills: ["./dist/skills"] },
		});
	});

	test("assigns each combined FFF and AFT tool slot to one owner", async () => {
		const toolNames: string[] = [];
		const pi = new Proxy(
			{
				events: new EventEmitter(),
				on: () => {},
				registerTool: (tool: { readonly name: string }) => toolNames.push(tool.name),
				registerCommand: () => {},
				registerShortcut: () => {},
				registerFlag: () => {},
				registerProvider: () => () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
				getCommands: () => [],
				getFlags: () => [],
				getTools: () => [],
			},
			{
				get(target, key) {
					return key in target ? target[key as keyof typeof target] : () => {};
				},
			},
		) as unknown as ExtensionAPI;
		for (const extension of hepiExtensions) await extension(pi);

		const slots = ["find", "grep", "read", "write", "edit", "apply_patch", "bash"];
		for (const slot of slots) {
			expect(toolNames.filter((name) => name === slot)).toHaveLength(1);
		}
		expect(getHepiRuntimeLoadoutGroupRegistry(pi).get("subagents")).toEqual({
			id: "subagents",
			label: "Subagents",
			items: ["agent", "get_subagent_result", "steer_subagent"],
		});
	});
});
