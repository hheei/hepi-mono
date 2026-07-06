#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const aliases = new Map([
	["extcore", "packages/pi-extcore/src/extension.ts"],
	["pi-extcore", "packages/pi-extcore/src/extension.ts"],
	["loadout", "packages/pi-loadout/src/index.ts"],
	["pi-loadout", "packages/pi-loadout/src/index.ts"],
	["example", "packages/pi-example/src/index.ts"],
	["pi-example", "packages/pi-example/src/index.ts"],
]);

function usage() {
	console.log(`Usage:
  bun run pi:dev                         # load pi-extcore + pi-loadout
  bun run pi:dev -- example              # load pi-extcore + pi-example
  bun run pi:dev -- loadout example      # load pi-extcore + pi-loadout + pi-example
  bun run pi:dev -- --all                # load every packages/pi-*/src entry
  bun run pi:dev -- path/to/index.ts     # load explicit extension path

Pass extra Pi flags after --, for example:
  bun run pi:dev -- loadout -- --model openai/gpt-5
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
	const glob = new Bun.Glob("packages/pi-*/src/{extension,index}.ts");
	return [...glob.scanSync({ cwd: root })].sort((a, b) => {
		if (a.includes("pi-extcore/")) return -1;
		if (b.includes("pi-extcore/")) return 1;
		return a.localeCompare(b);
	});
}

const extensionInputs = requested.length === 0 ? ["pi-extcore", "pi-loadout"] : requested;
const extensionPaths = extensionInputs.includes("--all")
	? allExtensionEntries()
	: ["pi-extcore", ...extensionInputs.filter((item) => item !== "pi-extcore")]
			.map(resolveExtension)
			.filter((item, index, list) => list.indexOf(item) === index);

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
