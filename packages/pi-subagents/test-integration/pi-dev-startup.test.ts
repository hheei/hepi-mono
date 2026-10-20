import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const root = process.cwd();
const loader = join(root, "node_modules/jiti/lib/jiti-register.mjs");

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-dev-startup-"));
	try {
		await mkdir(join(directory, "scripts"));
		await copyFile(join(root, "scripts/pi-dev.ts"), join(directory, "scripts/pi-dev.ts"));
		await writeFile(join(directory, "pnpm-lock.yaml"), "fixture");
		await writeFile(join(directory, "tsconfig.base.json"), "{}");
		await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
		for (const name of ["pi-ext-core", "pi-ext-tools"]) {
			const path = join(directory, "packages", name);
			await mkdir(join(path, "src"), { recursive: true });
			await mkdir(join(path, "dist"));
			await writeFile(join(path, "dist/extension.js"), "");
			await writeFile(join(path, "src/extension.ts"), "export {};");
			await writeFile(join(path, "package.json"), JSON.stringify({ name }));
		}
		await mkdir(join(directory, "bin"));
		const buildLog = join(directory, "build.log");
		await writeFile(
			join(directory, "bin/pnpm"),
			`#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(buildLog)}, process.cwd() + String.fromCharCode(10));
`,
			{ mode: 0o755 },
		);
		const cli = join(directory, "host.mjs");
		await writeFile(cli, "console.log(JSON.stringify(process.argv.slice(2)));");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CLI: cli,
			PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		};
		delete env.PI_SUBAGENTS_CHILD_ID;
		return {
			directory,
			buildLog,
			async launch(child: boolean) {
				return exec(
					process.execPath,
					["--import", loader, join(directory, "scripts/pi-dev.ts"), "--version"],
					{
						cwd: directory,
						env: { ...env, ...(child ? { PI_SUBAGENTS_CHILD_ID: "agent-1" } : {}) },
						timeout: 15_000,
					},
				);
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

test.skipIf(process.platform === "win32")(
	"child starts without building or replacing stale parent cache",
	async () => {
		const current = await fixture();
		try {
			await mkdir(join(current.directory, ".pi-dev"));
			const cache = join(current.directory, ".pi-dev/build.json");
			const stale = JSON.stringify({ typescriptFingerprint: "old-parent-build" });
			await writeFile(cache, stale);
			const { stdout } = await current.launch(true);
			const args: unknown = JSON.parse(stdout);
			expect(args).toContain("--version");
			expect(args).toContain(join(current.directory, "packages/pi-ext-tools/dist/extension.js"));
			expect(args).toContain("builtin:codemode");
			expect(args).not.toContain("builtin:tool-search");
			expect(await readFile(cache, "utf8")).toBe(stale);
			await expect(readFile(current.buildLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(current.directory, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"ordinary startup builds changed sources and reuses matching cache",
	async () => {
		const current = await fixture();
		try {
			await current.launch(false);
			const builds = (await readFile(current.buildLog, "utf8")).trim().split("\n");
			expect(builds).toEqual([
				join(current.directory, "packages/pi-ext-core"),
				join(current.directory, "packages/pi-ext-tools"),
			]);
			await current.launch(false);
			expect((await readFile(current.buildLog, "utf8")).trim().split("\n")).toEqual(builds);
			await writeFile(
				join(current.directory, "packages/pi-ext-tools/src/extension.ts"),
				"export const changed = true;",
			);
			await current.launch(true);
			expect((await readFile(current.buildLog, "utf8")).trim().split("\n")).toEqual(builds);
			await current.launch(false);
			expect((await readFile(current.buildLog, "utf8")).trim().split("\n")).toEqual([
				...builds,
				...builds,
			]);
		} finally {
			await rm(current.directory, { recursive: true, force: true });
		}
	},
);
