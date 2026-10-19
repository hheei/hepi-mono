import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { registerFindTool } from "../src/find.js";
import { registerGrepTool } from "../src/grep.js";
import { registerReadTool } from "../src/read.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-ext-tools-codemode-test-");

describe("file tools contract aligned with upstream pi 1.0.0", () => {
	test("read, grep, find contract aligned with upstream pi and declare readOnly hints", async () => {
		const host = toolHost();
		registerReadTool(host.pi);
		registerGrepTool(host.pi);
		registerFindTool(host.pi);

		const read = toolFor(host.tools, "read");
		const grep = toolFor(host.tools, "grep");
		const find = toolFor(host.tools, "find");

		// Aligned with upstream: no outputSchema so codemode scripts receive raw string output directly
		// Upstream Pi 1.1.0 read declares outputSchema for text/image union; grep and find have no outputSchema
		expect(read.outputSchema).toBeDefined();
		expect(grep.outputSchema).toBeUndefined();
		expect(find.outputSchema).toBeUndefined();

		// Safe optimizations: declare readOnly & idempotent hints
		expect(read.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
		expect(grep.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
		expect(find.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });

		const dir = await temporaryDirectory();
		await mkdir(join(dir, "subdir"));
		const filePath = join(dir, "sample.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");

		const readResult = await read.execute("read-1", { path: "sample.txt" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(readResult.structuredContent).toBe("alpha\nbeta\n");
		expect(readResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("alpha"),
		});

		const grepResult = await grep.execute("grep-1", { pattern: "alpha" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(grepResult.structuredContent).toBeUndefined();
		expect(grepResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("alpha"),
		});

		const findResult = await find.execute("find-1", { pattern: "sample" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(findResult.structuredContent).toBeUndefined();
		expect(findResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("sample.txt"),
		});
	});
});
