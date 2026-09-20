#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";
const isCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

console.log(`[publish-packages] Starting publication check (dryRun: ${isDryRun}, CI: ${isCi})`);

const output = execFileSync("pnpm", ["m", "ls", "--json", "--depth", "-1"], {
	cwd: repoRoot,
	encoding: "utf8",
});
const allPackages = JSON.parse(output);
if (!Array.isArray(allPackages))
	throw new Error("pnpm workspace inventory did not return an array");

const publicPackages = allPackages.filter((pkg) => pkg && typeof pkg === "object" && !pkg.private);
for (const pkg of publicPackages) {
	if (
		typeof pkg.name !== "string" ||
		typeof pkg.version !== "string" ||
		typeof pkg.path !== "string"
	) {
		throw new Error("pnpm returned an invalid public workspace record");
	}
	if (pkg.version !== rootManifest.version) {
		throw new Error(
			`${pkg.name} is ${pkg.version}, but the fixed repository release version is ${rootManifest.version}`,
		);
	}
}

const releaseTag = process.env.GITHUB_REF?.startsWith("refs/tags/")
	? process.env.GITHUB_REF.slice("refs/tags/".length)
	: undefined;
if (releaseTag && releaseTag !== `v${rootManifest.version}`) {
	throw new Error(
		`Release tag ${releaseTag} does not match repository version v${rootManifest.version}`,
	);
}

publicPackages.sort((left, right) => {
	if (left.name === "@hheei/pi-ext-core") return -1;
	if (right.name === "@hheei/pi-ext-core") return 1;
	return left.name.localeCompare(right.name);
});

console.log(
	`[publish-packages] Found ${publicPackages.length} public packages to process:\n` +
		publicPackages.map((pkg) => `  - ${pkg.name}@${pkg.version} (${pkg.path})`).join("\n"),
);

let publishedCount = 0;
let skippedCount = 0;

for (const pkg of publicPackages) {
	console.log(`\n========================================`);
	console.log(`Processing: ${pkg.name}@${pkg.version}`);
	console.log(`========================================`);

	const packageSpec = `${pkg.name}@${pkg.version}`;
	const lookup = spawnSync("npm", ["view", packageSpec, "version", "--json"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	const lookupText = `${lookup.stdout ?? ""}\n${lookup.stderr ?? ""}`;
	let isAlreadyPublished = false;
	if (lookup.status === 0) {
		isAlreadyPublished = JSON.parse(lookup.stdout.trim()) === pkg.version;
	} else if (!lookupText.includes("E404")) {
		throw new Error(`Unable to check ${packageSpec} on npm:\n${lookupText.trim()}`);
	}

	if (isAlreadyPublished) {
		console.log(`${packageSpec} is already published on npm. Skipping.`);
		skippedCount++;
		continue;
	}

	console.log(`Publishing ${packageSpec}...`);
	const publishArgs = ["--filter", pkg.name, "publish", "--access", "public", "--no-git-checks"];
	if (isDryRun) publishArgs.push("--dry-run");
	else if (isCi) publishArgs.push("--provenance");

	const result = spawnSync("pnpm", publishArgs, {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(`Failed to publish ${packageSpec} (exit ${result.status ?? "unknown"})`);
	}
	publishedCount++;
}

console.log(`\n========================================`);
console.log("Publish summary:");
console.log(`  Published / Dry-run: ${publishedCount}`);
console.log(`  Skipped (already on npm): ${skippedCount}`);
console.log(`========================================\n`);
