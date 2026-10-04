import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Pack with pnpm so workspace ranges are resolved, then inspect the actual npm artifact. */
export function packValidatedPackage(workspace, destination) {
	const output = execFileSync(
		"pnpm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
		{ cwd: workspace.path, encoding: "utf8" },
	);
	const inventory = JSON.parse(output);
	if (typeof inventory.filename !== "string") {
		throw new Error(`${workspace.name} pack did not return a tarball filename`);
	}
	const tarball = resolve(destination, inventory.filename);
	const manifest = JSON.parse(
		execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
	);
	if (manifest.name !== workspace.name || manifest.version !== workspace.version) {
		throw new Error(`${workspace.name} tarball identity does not match the workspace`);
	}
	validatePackedDependencies(manifest);
	const packedFiles = new Set(
		execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
			.trim()
			.split("\n")
			.map((path) => path.replace(/^package\//, "")),
	);
	for (const entry of manifestEntries(manifest)) {
		if (!packedFiles.has(entry)) {
			throw new Error(`${workspace.name} package entry is missing from its tarball: ${entry}`);
		}
	}
	if (!packedFiles.has("LICENSE")) {
		throw new Error(`${workspace.name} tarball does not contain LICENSE`);
	}
	const license = execFileSync("tar", ["-xOf", tarball, "package/LICENSE"], { encoding: "utf8" });
	if (!license.includes("Permission is hereby granted")) {
		throw new Error(`${workspace.name} does not include the complete MIT license text`);
	}
	return tarball;
}

export function validatePackedDependencies(manifest) {
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"devDependencies",
	]) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			if (typeof range !== "string" || /^(workspace:|link:|file:)/.test(range)) {
				throw new Error(
					`${manifest.name} tarball contains a non-installable ${field} range: ${name}=${range}`,
				);
			}
		}
	}
	for (const field of ["dependencies", "optionalDependencies"]) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			if (
				name === "typebox" ||
				/^@earendil-works\/pi-(agent-core|ai|coding-agent|tui)$/.test(name)
			) {
				throw new Error(
					`${manifest.name} must declare host-provided ${name} in peerDependencies, not ${field}`,
				);
			}
		}
	}
	if (
		manifest.peerDependencies?.typebox !== undefined &&
		manifest.peerDependencies.typebox !== "*"
	) {
		throw new Error(`${manifest.name} must declare host-provided typebox with a "*" peer range`);
	}
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
