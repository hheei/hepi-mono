import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { registerApplyPatchTool } from "../src/apply-patch/tool.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("pi-apply-patch-catalog-");

/** The extension owns apply_patch alone, so the host double stays caller-chosen. */
function registeredTool(): ReturnType<typeof toolFor> {
	const host = toolHost();
	registerApplyPatchTool(host.pi);
	return toolFor(host.tools, "apply_patch");
}

describe("pi-apply-patch catalog", () => {
	test("registers apply_patch with defaultActive: false", (): void => {
		const host = toolHost();
		registerApplyPatchTool(host.pi);
		expect(host.tools.map((tool) => tool.name)).toEqual(["apply_patch"]);
		expect(toolFor(host.tools, "apply_patch").defaultActive).toBe(false);
		expect(host.activeTools()).not.toContain("apply_patch");
	});

	test("activates apply_patch via host setActiveTools without modifying other tools", (): void => {
		const host = toolHost();
		registerApplyPatchTool(host.pi);
		const initial = host.activeTools();
		host.pi.setActiveTools([...initial, "apply_patch"]);
		expect(host.activeTools()).toContain("apply_patch");
		host.pi.setActiveTools([...initial]);
		expect(host.activeTools()).not.toContain("apply_patch");
	});

	test("registers apply_patch as strict V4A patch transport", (): void => {
		const applyPatch = registeredTool();

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

	test("executes apply_patch through its strict V4A transport", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const applyPatch = registeredTool();

		const result = await applyPatch.execute(
			"apply-patch-1",
			{ patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch" },
			undefined,
			undefined,
			{ cwd } as unknown as ExtensionToolContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Applied patch: 1 operations in 1 files.\nChanged:\n- created.txt: add",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
	});

	test("reports rejected operation count rather than rejection group count", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const applyPatch = registeredTool();

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
			{ cwd } as unknown as ExtensionToolContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Patch partially applied.\nChanged:\n- created.txt: add\nRejected:\n- operation 2, operation 3, first.txt: path touched more than once: first.txt",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
		await expect(readFile(join(cwd, "first.txt"), "utf8")).rejects.toThrow();
	});

	test("publishes successful hunks when another hunk fails", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const applyPatch = registeredTool();

		const result = await applyPatch.execute(
			"apply-patch-partial-hunks",
			{
				patch:
					"*** Begin Patch\n" +
					"*** Update File: value.txt\n" +
					"@@\n-one\n+ONE\n" +
					"@@\n-missing\n+MISS\n" +
					"@@\n-five\n+FIVE\n" +
					"*** End Patch",
			},
			undefined,
			undefined,
			{ cwd } as unknown as ExtensionToolContext,
		);

		expect(result.details).toMatchObject({
			status: "partial",
			operations: [{ status: "partial", appliedHunks: 2, totalHunks: 3 }],
		});
		expect(result.content).toContainEqual({
			type: "text",
			text:
				"Patch partially applied.\n" +
				"Changed:\n" +
				"- value.txt: update (2/3 hunks applied)\n" +
				"Rejected:\n" +
				"- operation 1, value.txt, hunk 2: context not found",
		});
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
	});
});
