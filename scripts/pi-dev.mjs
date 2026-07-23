#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const aliases = new Map([
	["basics", "packages/pi-basics/src/index.ts"],
	["pi-basics", "packages/pi-basics/src/index.ts"],
]);

function usage() {
	console.log(`Usage:
  bun run pi:dev                         # load pi-basics
  bun run pi:dev -- basics                # load pi-basics
  bun run pi:dev -- inturl                # load a specific extension
  bun run pi:dev -- --all                 # load every active packages/pi-*/src entry
  bun run pi:dev -- path/to/index.ts      # load explicit extension path

Pass extra Pi flags after --, for example:
  bun run pi:dev -- basics -- --model openai/gpt-5
`);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
	usage();
	process.exit(0);
}

const separatorIndex = rawArgs.indexOf("--");
const requested = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
const piArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);

function packageEntry(packageName) {
	return `packages/${packageName}/src/index.ts`;
}

function resolveExtension(input) {
	const mapped = aliases.get(input);
	if (mapped) return mapped;

	const packagePath = packageEntry(input.startsWith("pi-") ? input : `pi-${input}`);
	if (existsSync(path.join(root, packagePath))) return packagePath;

	return input;
}

function allExtensionEntries() {
	const packageGlob = new Bun.Glob("packages/pi-*/package.json");
	const entries = [];
	for (const packageJson of packageGlob.scanSync({ cwd: root })) {
		const packageDir = path.dirname(packageJson);
		const extension = path.join(packageDir, "src/extension.ts");
		const index = path.join(packageDir, "src/index.ts");
		entries.push(existsSync(path.join(root, extension)) ? extension : index);
	}
	return entries.sort((a, b) => a.localeCompare(b));
}

function projectSubagentsExtension() {
	const settingsPath = path.join(root, ".pi", "settings.json");
	if (!existsSync(settingsPath)) return undefined;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (
			!Array.isArray(settings.packages) ||
			!settings.packages.some(
				(value) => typeof value === "string" && value.startsWith("npm:@tintinweb/pi-subagents"),
			)
		)
			return undefined;
		const extensionPath = ".pi/npm/node_modules/@tintinweb/pi-subagents/src/index.ts";
		return existsSync(path.join(root, extensionPath)) ? extensionPath : undefined;
	} catch {
		return undefined;
	}
}

const extensionInputs = requested.length === 0 ? ["pi-basics"] : requested;
let extensionPaths = extensionInputs.includes("--all")
	? allExtensionEntries()
	: extensionInputs
			.map(resolveExtension)
			.filter((item, index, list) => list.indexOf(item) === index);

const subagentsExtension = projectSubagentsExtension();
if (extensionPaths.includes(aliases.get("basics")) && subagentsExtension)
	extensionPaths = [subagentsExtension, ...extensionPaths];

for (const extensionPath of extensionPaths) {
	const absolutePath = path.isAbsolute(extensionPath)
		? extensionPath
		: path.join(root, extensionPath);
	if (!existsSync(absolutePath)) {
		console.error(`Extension not found: ${extensionPath}`);
		process.exit(1);
	}
}

const args = ["--no-extensions", "--no-skills", "--approve"];
for (const extensionPath of extensionPaths) {
	args.push("-e", path.isAbsolute(extensionPath) ? extensionPath : path.join(root, extensionPath));
}
args.push(...piArgs);

console.log("Starting pi with mono extensions only:");
for (const extensionPath of extensionPaths) {
	console.log(`  - ${extensionPath}`);
}

const child = spawn("pi", args, {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
