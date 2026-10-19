#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { packValidatedPackage, RUNTIME_ARTIFACTS } from "./package-artifact.mjs";
import { runPackedArtifactSmoke } from "./package-artifact-smoke.mjs";

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

const runtimeArtifactOwners = publicPackages
	.filter((workspace) => RUNTIME_ARTIFACTS[workspace.name] !== undefined)
	.map((workspace) => workspace.name);
if (runtimeArtifactOwners.length > 0) {
	console.log(
		`[validate-package-artifacts] Executing packed runtime assets for ${runtimeArtifactOwners.join(", ")}; ` +
			"their dependencies resolve through the owner's workspace node_modules symlink, not a network install.",
	);
}

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

	const destination = mkdtempSync(join(tmpdir(), "pi-package-validation-"));
	let reports;
	try {
		const tarball = packValidatedPackage(workspace, destination);
		reports = await runPackedArtifactSmoke(workspace, tarball, destination);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
	const suffix = reports.length === 0 ? "" : ` (ran ${reports.join(", ")})`;

	console.log(`✓ ${workspace.name}@${workspace.version}${suffix}`);
}

console.log(`[validate-package-artifacts] Validated ${publicPackages.length} public packages.`);
