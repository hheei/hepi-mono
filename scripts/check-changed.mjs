#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
const isWrite = args.includes("--write") || args.includes("--fix");
const extraArgs = args.filter((arg) => arg !== "--write" && arg !== "--fix");

const gitOutput = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
	cwd: repoRoot,
	encoding: "utf8",
});

const supportedExtensions = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	".md",
	".yaml",
	".yml",
]);

const changedFiles = [];

for (const line of gitOutput.split("\n")) {
	if (!line) continue;
	const status = line.slice(0, 2);
	// Skip deleted files
	if (status.includes("D")) continue;

	let relativePath = line.slice(3).trim();
	// Handle renames (e.g., "R  old -> new")
	if (relativePath.includes(" -> ")) {
		relativePath = relativePath.split(" -> ")[1].trim();
	}
	// Strip quotes if present
	if (relativePath.startsWith('"') && relativePath.endsWith('"')) {
		relativePath = relativePath.slice(1, -1);
	}

	const ext = relativePath.slice(relativePath.lastIndexOf("."));
	if (!supportedExtensions.has(ext)) continue;

	const fullPath = resolve(repoRoot, relativePath);
	if (existsSync(fullPath)) {
		changedFiles.push(relativePath);
	}
}

if (changedFiles.length === 0) {
	console.log("[check-changed] No changed files requiring Biome check.");
	process.exit(0);
}

console.log(`[check-changed] Checking ${changedFiles.length} changed file(s):`);
for (const file of changedFiles) {
	console.log(`  - ${file}`);
}

const biomeFlags = isWrite ? ["check", "--write", ...extraArgs] : ["check", ...extraArgs];

try {
	execFileSync("pnpm", ["exec", "biome", ...biomeFlags, ...changedFiles], {
		cwd: repoRoot,
		stdio: "inherit",
	});
} catch (error) {
	process.exit(error.status ?? 1);
}
