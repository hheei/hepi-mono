#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basicsExtension = "packages/pi-basics/src/extension.ts";

const aliases = new Map([
	["basics", basicsExtension],
	["pi-basics", basicsExtension],
]);

function usage() {
	console.log(`Usage:
  bun run pi:dev                         # load pi-basics
  bun run pi:dev -- basics                # load pi-basics
  bun run pi:dev -- todo                  # load a specific extension
  bun run pi:dev -- basics todo           # load several extensions
  bun run pi:dev -- --all                 # load every packages/pi-* pi.extensions entry
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
	const glob = new Bun.Glob("packages/pi-*/package.json");
	return [...glob.scanSync({ cwd: root })]
		.flatMap((manifestPath) => {
			try {
				const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
				if (!Array.isArray(manifest.pi?.extensions)) return [];
				return manifest.pi.extensions
					.filter((entry) => typeof entry === "string")
					.map((entry) => path.join(path.dirname(manifestPath), entry));
			} catch {
				return [];
			}
		})
		.sort((a, b) => {
			if (a === basicsExtension) return -1;
			if (b === basicsExtension) return 1;
			return a.localeCompare(b);
		});
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
