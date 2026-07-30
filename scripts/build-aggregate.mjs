#!/usr/bin/env bun
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aggregatePackages = ["hepi-aft", "hepi-basics", "hepi-tools", "hepi-skills", "hepi-mono"];
const publicContracts = {
	"hepi-aft": "hepiAftExtensions",
	"hepi-basics": "hepiBasicsExtensions",
	"hepi-tools": "hepiToolsExtensions",
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
	"@hheei/hepi-aft",
	"@hheei/hepi-mctx",
	"@hheei/hepi-subagents",
];
const alias = {
	"@mariozechner/pi-agent-core": "@earendil-works/pi-agent-core",
	"@mariozechner/pi-ai": "@earendil-works/pi-ai",
	"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
	"@mariozechner/pi-tui": "@earendil-works/pi-tui",
};

const magicContextPackage = path.join(root, "packages", "hepi-mctx", "packages", "pi-plugin");
const magicContextLink = path.join(root, "node_modules", "@hheei", "hepi-mctx");
mkdirSync(path.dirname(magicContextLink), { recursive: true });
rmSync(magicContextLink, { force: true, recursive: true });
symlinkSync(magicContextPackage, magicContextLink, "dir");

const subagentsPackage = path.join(root, "packages", "hepi-subagents");
const subagentsLink = path.join(root, "node_modules", "@hheei", "hepi-subagents");
rmSync(subagentsLink, { force: true, recursive: true });
symlinkSync(subagentsPackage, subagentsLink, "dir");

const sourcePackageLinks = [
	[
		path.join(root, "packages", "hepi-mono"),
		"@hheei",
		"hepi-aft",
		path.join(root, "packages", "hepi-aft"),
	],
	[path.join(root, "packages", "hepi-mono"), "@hheei", "hepi-mctx", magicContextPackage],
	[path.join(root, "packages", "hepi-mono"), "@hheei", "hepi-subagents", subagentsPackage],
	[magicContextPackage, "@hheei", "hepi-subagents", subagentsPackage],
];

for (const [packageRoot, scope, name, target] of sourcePackageLinks) {
	const link = path.join(packageRoot, "node_modules", scope, name);
	mkdirSync(path.dirname(link), { recursive: true });
	const linkStat = lstatSync(link, { throwIfNoEntry: false });
	if (linkStat) {
		if (!linkStat.isSymbolicLink()) {
			throw new Error(`Expected source package link, found a real directory: ${link}`);
		}
		rmSync(link);
	}
	symlinkSync(target, link, "dir");
}

const magicContextCoreModules = path.join(
	root,
	"packages",
	"hepi-mctx",
	"packages",
	"plugin",
	"node_modules",
);
const magicContextPackageModules = path.join(magicContextPackage, "node_modules");
let createdMagicContextCoreLink = false;
if (existsSync(magicContextPackageModules)) {
	if (existsSync(magicContextCoreModules)) {
		if (!lstatSync(magicContextCoreModules).isSymbolicLink()) {
			throw new Error("Magic Context shared core has its own node_modules");
		}
		rmSync(magicContextCoreModules);
	}
	symlinkSync(magicContextPackageModules, magicContextCoreModules, "dir");
	createdMagicContextCoreLink = true;
}

const aftPiPackage = path.join(root, "third_party", "aft", "packages", "pi-plugin");
const aftPiLink = path.join(root, "node_modules", "@cortexkit", "aft-pi");
mkdirSync(path.dirname(aftPiLink), { recursive: true });
rmSync(aftPiLink, { force: true, recursive: true });
symlinkSync(aftPiPackage, aftPiLink, "dir");

const requested = process.argv.slice(2);
const packageNames = requested.includes("--all")
	? aggregatePackages
	: requested.length > 0
		? requested
		: aggregatePackages;

try {
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
		const entrypoints = [path.join(sourceRoot, "extension.ts")];
		if (packageName === "hepi-mono") {
			entrypoints.push(path.join(magicContextPackage, "src", "subagent-entry.ts"));
		}
		const result = await Bun.build({
			entrypoints,
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
		if (packageName === "hepi-skills" || packageName === "hepi-mono") {
			const skillsSource = path.join(root, "packages", "hepi-skills", "src", "skills");
			const skillsOutput = path.join(outputRoot, "skills");
			cpSync(skillsSource, skillsOutput, { recursive: true });
		}
		if (packageName === "hepi-mono") {
			const themesSource = path.join(root, "packages", "hepi-basics", "themes");
			const themesOutput = path.join(outputRoot, "themes");
			cpSync(themesSource, themesOutput, { recursive: true });
		}
		writeFileSync(
			path.join(outputRoot, "index.d.ts"),
			[
				'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
				"",
				"export type HepiExtension = (pi: ExtensionAPI) => void | Promise<void>;",
				`export declare const ${extensionArray}: readonly HepiExtension[];`,
				"export default function extension(pi: ExtensionAPI): void | Promise<void>;",
				"",
			].join("\n"),
		);
		console.log(`Built @hheei/${packageName}`);
	}
} finally {
	if (createdMagicContextCoreLink) rmSync(magicContextCoreModules, { force: true });
}
