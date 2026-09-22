#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
/** Every public workspace owns its release version; only the shape is enforced here. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const workspaceOutput = execFileSync("pnpm", ["m", "ls", "--json", "--depth", "-1"], {
	cwd: repoRoot,
	encoding: "utf8",
});
const workspaces = JSON.parse(workspaceOutput);

if (!Array.isArray(workspaces)) {
	throw new Error("pnpm workspace inventory did not return an array");
}

const publicPackages = workspaces
	.filter((workspace) => workspace && typeof workspace === "object" && !workspace.private)
	.sort((left, right) => String(left.name).localeCompare(String(right.name)));

for (const workspace of publicPackages) {
	if (
		typeof workspace.name !== "string" ||
		typeof workspace.version !== "string" ||
		typeof workspace.path !== "string"
	) {
		throw new Error("pnpm returned an invalid public workspace record");
	}
	if (!SEMVER_PATTERN.test(workspace.version)) {
		throw new Error(`${workspace.name} has an invalid release version: ${workspace.version}`);
	}

	const packageRoot = workspace.path;
	const manifest = readJson(resolve(packageRoot, "package.json"));
	const inventoryOutput = execFileSync(
		"pnpm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{ cwd: packageRoot, encoding: "utf8" },
	);
	const inventory = JSON.parse(inventoryOutput);
	if (!Array.isArray(inventory.files)) {
		throw new Error(`${workspace.name} pack inventory has no files array`);
	}
	const packedFiles = new Set(
		inventory.files.map((file) => {
			if (!file || typeof file.path !== "string") {
				throw new Error(`${workspace.name} pack inventory contains an invalid file`);
			}
			return normalizePackagePath(file.path);
		}),
	);

	for (const entry of manifestEntries(manifest)) {
		if (!packedFiles.has(entry)) {
			throw new Error(`${workspace.name} package entry is missing from its tarball: ${entry}`);
		}
	}

	if (!packedFiles.has("LICENSE")) {
		throw new Error(`${workspace.name} tarball does not contain LICENSE`);
	}
	const packageLicense = resolve(packageRoot, "LICENSE");
	let licenseText;
	try {
		licenseText = readFileSync(packageLicense, "utf8");
	} catch {
		licenseText = readFileSync(resolve(repoRoot, "LICENSE"), "utf8");
	}
	if (!licenseText.includes("Permission is hereby granted")) {
		throw new Error(`${workspace.name} does not include the complete MIT license text`);
	}

	console.log(`✓ ${workspace.name}@${workspace.version}`);
}

console.log(`[validate-package-artifacts] Validated ${publicPackages.length} public packages.`);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function normalizePackagePath(path) {
	return path.replace(/^\.\//, "");
}

function manifestEntries(manifest) {
	const entries = new Set();
	addString(entries, manifest.main);
	addString(entries, manifest.types);
	addExportTargets(entries, manifest.exports);

	if (manifest.pi && typeof manifest.pi === "object" && Array.isArray(manifest.pi.extensions)) {
		for (const extension of manifest.pi.extensions) addString(entries, extension);
	}
	if (typeof manifest.bin === "string") {
		addString(entries, manifest.bin);
	} else if (manifest.bin && typeof manifest.bin === "object") {
		for (const target of Object.values(manifest.bin)) addString(entries, target);
	}
	return entries;
}

function addExportTargets(entries, value) {
	if (typeof value === "string") {
		addString(entries, value);
		return;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	for (const target of Object.values(value)) addExportTargets(entries, target);
}

function addString(entries, value) {
	if (typeof value === "string") entries.add(normalizePackagePath(value));
}
