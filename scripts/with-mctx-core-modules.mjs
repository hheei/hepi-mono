#!/usr/bin/env bun
import { existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "packages", "hepi-mctx");
const packageModules = path.join(packageRoot, "node_modules");
const coreModules = path.join(
	root,
	"third_party",
	"magic-context",
	"packages",
	"plugin",
	"node_modules",
);
const command = process.argv.slice(2);

if (command.length === 0) {
	console.error("Usage: bun scripts/with-mctx-core-modules.mjs <command> [...args]");
	process.exit(1);
}
if (!existsSync(packageModules)) {
	console.error(
		"Missing packages/hepi-mctx/node_modules; run bun install from the repository root.",
	);
	process.exit(1);
}

let createdLink = false;
if (existsSync(coreModules)) {
	if (!lstatSync(coreModules).isSymbolicLink()) {
		console.error(
			"Magic Context core has its own node_modules; remove it before using the HEPI build.",
		);
		process.exit(1);
	}
	rmSync(coreModules);
}
symlinkSync(packageModules, coreModules, process.platform === "win32" ? "junction" : "dir");
createdLink = true;

try {
	const result = Bun.spawnSync(command, { cwd: packageRoot, stdout: "inherit", stderr: "inherit" });
	process.exitCode = result.exitCode ?? 1;
} finally {
	if (createdLink) rmSync(coreModules, { force: true });
}
