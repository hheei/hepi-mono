#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
	["packages/hepi-basics", "dist/extension.js"],
	["packages/hepi-tools", "dist/extension.js"],
	["packages/hepi-skills", "dist/extension.js"],
	["packages/hepi-aft", "dist/extension.js"],
	["packages/hepi-mctx/packages/pi-plugin", "dist/index.js"],
	["packages/hepi-mono", "dist/extension.js"],
	["third_party/pi-subagents", "dist/index.js"],
];

for (const [packagePath, entrypoint] of packages) {
	console.log(`Packing ${packagePath}`);
	const result = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], {
		cwd: path.join(root, packagePath),
		stdout: "inherit",
		stderr: "inherit",
	});
	if (!result.success) process.exit(result.exitCode ?? 1);
	if (!existsSync(path.join(root, packagePath, entrypoint))) {
		console.error(`Pack did not build ${path.join(packagePath, entrypoint)}`);
		process.exit(1);
	}
}
