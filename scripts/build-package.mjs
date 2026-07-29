#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = process.argv[2];
const aggregatePackages = new Set([
	"hepi-aft",
	"hepi-basics",
	"hepi-tools",
	"hepi-skills",
	"hepi-mono",
]);

if (packageName === undefined || !aggregatePackages.has(packageName)) {
	console.error(`Usage: bun scripts/build-package.mjs <${[...aggregatePackages].join("|")}>`);
	process.exit(1);
}

function run(args) {
	const result = Bun.spawnSync(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
	if (!result.success) process.exit(result.exitCode ?? 1);
}

if (packageName === "hepi-aft" || packageName === "hepi-mono") run(["bun", "run", "build:aft-pi"]);
if (packageName === "hepi-mono") run(["bun", "run", "build:magic-context"]);
run(["bun", "scripts/build-aggregate.mjs", packageName]);
