import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./publish-packages.mjs", import.meta.url));

for (const [range, valid] of [
	["^0.3.0", true],
	["workspace:^", false],
]) {
	test(`published dependency ${range} ${valid ? "can be skipped" : "blocks publication"}`, () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-publish-registry-"));
		try {
			const manifest = {
				name: "@hheei/pi-bg-bash",
				version: "0.1.0",
				dependencies: { "@hheei/pi-ext-core": range },
			};
			const inventory = [{ ...manifest, path: directory }];
			writeFileSync(
				join(directory, "pnpm"),
				`#!/usr/bin/env node\nif (process.argv[2] !== "m") throw new Error("unexpected pack");\nconsole.log(${JSON.stringify(JSON.stringify(inventory))});\n`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(directory, "npm"),
				`#!/usr/bin/env node\nif (process.argv[2] !== "view") throw new Error("unexpected publish");\nconsole.log(${JSON.stringify(JSON.stringify(manifest))});\n`,
				{ mode: 0o755 },
			);
			const result = spawnSync(process.execPath, [script, "--dry-run"], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` },
			});
			if (valid) {
				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stdout, /Skipped \(already on npm\): 1/);
			} else {
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /non-installable dependencies range/);
				assert.doesNotMatch(result.stdout, /Skipping\./);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
