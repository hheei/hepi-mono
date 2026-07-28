#!/usr/bin/env bun
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aggregatePackages = [
	"hepi-aft",
	"hepi-basics",
	"hepi-tools",
	"hepi-mctx",
	"hepi-skills",
	"hepi-mono",
];
const publicContracts = {
	"hepi-aft": "hepiAftExtensions",
	"hepi-basics": "hepiBasicsExtensions",
	"hepi-tools": "hepiToolsExtensions",
	"hepi-mctx": "hepiMctxExtensions",
	"hepi-skills": "hepiSkillsExtensions",
	"hepi-mono": "hepiExtensions",
};
const external = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/*",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/*",
	"ffi-rs",
	"@ff-labs/fff-bun",
	"@ff-labs/fff-node",
	"@ff-labs/fff-bin-*",
];
const alias = {
	"@mariozechner/pi-agent-core": "@earendil-works/pi-agent-core",
	"@mariozechner/pi-ai": "@earendil-works/pi-ai",
	"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
	"@mariozechner/pi-tui": "@earendil-works/pi-tui",
};

const requested = process.argv.slice(2);
const packageNames = requested.includes("--all")
	? aggregatePackages
	: requested.length > 0
		? requested
		: aggregatePackages;

for (const packageName of packageNames) {
	if (!aggregatePackages.includes(packageName)) {
		console.error(`Unknown aggregate package: ${packageName}`);
		process.exitCode = 1;
		continue;
	}

	const packageRoot = path.join(root, "packages", packageName);
	const sourceRoot = path.join(packageRoot, "src");
	const outputRoot = path.join(packageRoot, "dist");
	if (!existsSync(path.join(sourceRoot, "extension.ts"))) {
		console.error(`Aggregate entry not found: ${packageName}`);
		process.exitCode = 1;
		continue;
	}

	rmSync(outputRoot, { force: true, recursive: true });
	const result = await Bun.build({
		entrypoints: [path.join(sourceRoot, "extension.ts")],
		outdir: outputRoot,
		naming: "[name].js",
		bundle: true,
		format: "esm",
		target: "node",
		sourcemap: "none",
		external,
		alias,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exitCode = 1;
		continue;
	}

	const extensionArray = publicContracts[packageName];
	writeFileSync(
		path.join(outputRoot, "index.js"),
		`export { default, ${extensionArray} } from "./extension.js";\n`,
	);
	if (packageName === "hepi-tools" || packageName === "hepi-mono") {
		const binarySource = path.join(
			root,
			"packages",
			"hepi-tools",
			"src",
			"pi-codex-tool",
			"tools",
			"apply-patch",
			"bin",
		);
		cpSync(binarySource, path.join(outputRoot, "bin"), { recursive: true });
	}
	if (packageName === "hepi-skills" || packageName === "hepi-mono") {
		const skillsSource = path.join(root, "packages", "hepi-skills", "src", "skills");
		const skillsOutput = path.join(outputRoot, "skills");
		cpSync(skillsSource, skillsOutput, { recursive: true });
	}
	writeFileSync(
		path.join(outputRoot, "index.d.ts"),
		[
			'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
			"",
			"export type HepiExtension = (pi: ExtensionAPI) => void;",
			`export declare const ${extensionArray}: readonly HepiExtension[];`,
			"export default function extension(pi: ExtensionAPI): void;",
			"",
		].join("\n"),
	);
	console.log(`Built @hheei/${packageName}`);
}
